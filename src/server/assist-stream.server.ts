import {
  buildGeneratorPrompts,
  buildHarnessChatPrompt,
  buildHarnessEditPrompt,
  assembleAssistMessages,
  cacheOptsForSession,
  collectManifestSections,
  composeChatMessages,
  composeScenePlannerMessages,
  extractAnchorContext,
  getActiveContextWindow,
  formatCacheInfo,
  loadSimplePrompt,
  parsePlannerOutput,
  prefixHash,
  runPlannerPrompt,
  taggedPaths,
  workspaceIndexLine,
  type SimpleAssistRequest,
} from './assist.server'
import { loadLlmConfig } from './llm.server'
import { readCharacterState } from './characters.server'
import { formatCharacterPrompt } from '../lib/characters'
import {
  HARNESS_DESCRIPTORS,
  isServiceTransport,
  resolveHarnessArgv,
  runHarness,
  stripAnsi,
  toolEventPath,
} from './harness.server'
import {
  clearHarnessSession,
  getPendingWriteClarification,
  getHarnessSession,
  getWorkspaceAiLogs,
  registerController,
  restorePendingWriteClarification,
  releaseController,
  savePendingWriteClarification,
  saveSimpleAiLog,
  setHarnessSession,
  takePendingWriteClarification,
  type PendingWriteClarification,
} from './sessions.server'
import { readWorkspaceFile, requestSettings, requestWorkspaceDir, writeWorkspaceFile } from './storage.server'
import { errMsg, sse } from './http.server'
import {
  runHarnessPostProcess,
  runPostProcessPipeline,
  stripCodeFences,
  type HarnessPostProcessResult,
  type PostProcessEvent,
  type PostProcessGenerator,
} from './post-process.server'
import { enabledPostProcessPasses, normalizePostProcessing } from '../lib/postProcessing'
import { expandMentionedFiles } from './mentions.server'
import { createSceneDraftingAgent, createScenePlannerAgent } from './scene-agents.server'
import {
  createAssistChatAgent,
  createAssistEditAgent,
  createAssistOrchestratorAgent,
  createAssistPlannerAgent,
  createAssistPostProcessAgent,
  createWriteClarificationAgent,
  createWriteEvaluationAgent,
  createWriteStageAgent,
  logprobProviderOptions,
  type AssistAgentTelemetry,
} from './assist-agents.server'
import { splitThinkingTags, ThinkingTagFilter } from './thinking-filter.server'
import { tool, type ModelMessage, type ToolSet } from 'ai'
import { z } from 'zod'
import { recallMemoryContext } from './memory.server'
import { memoryConfig } from './memory.server'
import { WRITING_PIPELINE_STAGES, runWritingPipeline } from './writing-pipeline.server'
import {
  buildWritingEvaluationPrompt,
  evaluateDraftDeterministically,
  evaluatePredictablePatterns,
  buildAutomaticProseRevisionPrompt,
  parseWritingModelReview,
  attachPerplexity,
  extractTokenLogprobs,
} from './writing-evaluation.server'
import type {
  WritingEvaluationRecord,
  WritingEvaluationResult,
  WritingModelReview,
} from '../lib/writingEvaluation'
import { checkEnglishStyle } from './english-style-checker.server'

interface WriteClarificationQuestion {
  id: string
  question: string
  context?: string
  options: string[]
}

const MAX_WRITE_CLARIFICATION_ROUNDS = 4
const THINKING_OUTPUT_RESERVE = 2000

/** `maxOutputTokens` includes reasoning tokens on thinking models. */
function generationBudget(
  visibleTokens: number | null,
  thinking: boolean,
  promptChars?: number,
  contextWindow?: number,
): number | undefined {
  if (visibleTokens == null) return undefined
  const requested = visibleTokens + (thinking ? THINKING_OUTPUT_RESERVE : 0)
  if (!promptChars || !contextWindow || contextWindow <= 0) return requested
  const promptTokens = Math.ceil(promptChars / 4)
  const available = Math.max(visibleTokens, contextWindow - promptTokens - 256)
  return Math.min(requested, available)
}

function messageChars(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => {
    if (typeof message.content === 'string') return total + message.content.length
    return total + message.content.reduce((length, part) => {
      if (typeof part === 'string') return length + part.length
      if ('text' in part && typeof part.text === 'string') return length + part.text.length
      return length
    }, 0)
  }, 0)
}

function normalizeWriteClarificationQuestions(input: unknown): WriteClarificationQuestion[] {
  if (!input || typeof input !== 'object') return []
  const questions = (input as { questions?: unknown }).questions
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 12) return []
  const normalized = questions.flatMap((item): WriteClarificationQuestion[] => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    if (
      typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(raw.id) ||
      typeof raw.question !== 'string' || !raw.question.trim() || raw.question.length > 400 ||
      !Array.isArray(raw.options)
    ) return []
    const options = [...new Set(
      raw.options
        .filter((option): option is string => typeof option === 'string')
        .map((option) => option.trim())
        .filter((option) => option && option.length <= 200 && option.toLowerCase() !== 'other'),
    )]
    if (options.length < 2 || options.length > 4) return []
    const context = typeof raw.context === 'string' ? raw.context.trim().slice(0, 400) : ''
    return [{
      id: raw.id,
      question: raw.question.trim(),
      ...(context ? { context } : {}),
      options,
    }]
  })
  if (
    normalized.length !== questions.length ||
    new Set(normalized.map((question) => question.id)).size !== normalized.length
  ) return []
  return normalized
}

function validateWriteClarificationAnswers(
  questions: WriteClarificationQuestion[],
  rawAnswers: unknown,
): { byId: Record<string, string>; byQuestion: Record<string, string> } {
  if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
    throw new Error('Clarification answers are required.')
  }
  const input = rawAnswers as Record<string, unknown>
  const expectedIds = new Set(questions.map((question) => question.id))
  const submittedIds = Object.keys(input)
  if (
    submittedIds.length !== questions.length ||
    submittedIds.some((id) => !expectedIds.has(id))
  ) {
    throw new Error('The clarification answers do not match the pending questions.')
  }
  const byId = Object.create(null) as Record<string, string>
  const byQuestion = Object.create(null) as Record<string, string>
  for (const question of questions) {
    const answer = input[question.id]
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 2000) {
      throw new Error('Each clarification question needs an answer under 2,000 characters.')
    }
    byId[question.id] = answer.trim()
    byQuestion[question.question] = answer.trim()
  }
  return { byId, byQuestion }
}

export function runSimpleAssist(payload: SimpleAssistRequest, request: Request): Response {
  const ctrl = payload.session_id ? registerController(payload.session_id) : new AbortController()
  const signal = ctrl.signal

  const stream = new ReadableStream({
    start(c) {
      // Do not return the generation promise from `start`: some runtimes wait
      // for that promise to settle before exposing queued chunks to the
      // response reader, which turns this SSE endpoint into a buffered one.
      void (async () => {
      const send = (obj: unknown) => c.enqueue(new TextEncoder().encode(sse(obj)))
      let systemPrompt = ''
      let userPrompt = ''
      let claimedWriteClarification: PendingWriteClarification | null = null
      const editMode = payload.selected_text ? 'replace' : 'insert'
      try {
        const settings = await requestSettings(request)
        const ws = await requestWorkspaceDir(request)
        const characterState = await readCharacterState(ws).catch((error) => {
          console.warn(`Character context unavailable: ${errMsg(error)}`)
          return null
        })
        const characterMessage = characterState
          ? formatCharacterPrompt(characterState)
          : null
        const mode = payload.mode.trim().toLowerCase()
        const questionnaireAnswers = payload.clarification_answers ?? payload.write_answers
        const answerLines = Object.entries(questionnaireAnswers ?? {}).map(([question, answer]) =>
          `${question}: ${Array.isArray(answer) ? answer.join(', ') : answer}`,
        )
        const requestMessage = answerLines.length
          ? `${payload.message}\n\nClarification answers:\n${answerLines.join('\n')}`
          : payload.message
        const isPlannerDraft = mode === 'planner_draft'
        const harness =
          !isPlannerDraft && payload.harness && payload.harness !== 'api'
            ? payload.harness
            : null
        const isPlanner = mode === 'planner'
        const harnessMode: 'chat' | 'edit' = isPlanner || isPlannerDraft ? 'chat' : mode === 'edit' ? 'edit' : 'chat'
        const readFile = (p: string) => readWorkspaceFile(p, ws).catch(() => null)
        const plannerSessionLogs =
          isPlannerDraft && payload.session_id
            ? await getWorkspaceAiLogs(ws, payload.session_id).catch(() => [])
            : []
        const priorPlannerLogs = plannerSessionLogs.filter(
          (log) => log.mode === 'planner' || log.mode === 'planner_draft',
        )
        const priorPlannerRefs = priorPlannerLogs.flatMap((log) =>
          Array.isArray(log.ref_files)
            ? log.ref_files.flatMap((file) =>
                typeof file?.path === 'string' ? [file.path] : [],
              )
            : [],
        )
        // Expand prompt @mentions once: every branch (planner, writer, harness,
        // chat) sees the same transitive reference set, and context_resolved
        // reports what was actually included.
        const tagged = await expandMentionedFiles({
          roots: [...taggedPaths(payload), ...priorPlannerRefs],
          text: [
            payload.message,
            payload.draft_plan ?? '',
            ...priorPlannerLogs.map((log) => log.instruction),
            characterState?.current_state.location ?? '',
            characterState?.current_state.description ?? '',
          ].join('\n'),
          availableFiles: payload.available_files,
          readFile,
          ignoredRefFiles: (settings as { ignored_ref_files?: string[] }).ignored_ref_files,
        })
        const postConfig = normalizePostProcessing(settings.post_processing)
        const sendPostEvent = (event: PostProcessEvent) => {
          if (event.type === 'start') {
            send({ status: 'post_processing_start', source: event.source, total: event.total })
          } else if (event.type === 'pass_start') {
            send({
              status: 'post_processing_pass',
              source: event.source,
              index: event.index,
              total: event.total,
              id: event.id,
              name: event.name,
            })
          } else if (event.type === 'pass_done') {
            send({
              status: 'post_processing_pass_done',
              source: event.source,
              index: event.index,
              total: event.total,
              id: event.id,
              name: event.name,
              result_status: event.status,
              detail: event.error,
            })
          } else if (event.type === 'skipped') {
            send({ status: 'post_processing_skipped', source: event.source, reason: event.reason })
          }
        }
        const generatePass: PostProcessGenerator = async (input) => {
          const passMaxTokens = input.maxTokens == null
            ? undefined
            : input.maxTokens + (input.disableThinking ? 0 : THINKING_OUTPUT_RESERVE)
          const agent = createAssistPostProcessAgent({
            endpoint: {
              model: input.client.model,
              baseUrl: input.client.baseUrl,
              apiKey: input.client.apiKey,
            },
            instructions: input.system,
            temperature: input.temperature,
            maxOutputTokens: passMaxTokens,
            disableThinking: input.disableThinking,
          })
          const result = await agent.generate({
            messages: input.messages.filter(
              (message) => message.role !== 'system',
            ) as ModelMessage[],
            abortSignal: input.signal,
          })
          const filtered = splitThinkingTags(
            result.text,
            input.client.isThinking,
            input.client.customOpeningTags,
            input.client.customClosingTags,
          )
          return {
            text: filtered.text,
            model: result.response.modelId || input.client.model,
            finishReason: result.finishReason,
            promptTokens: result.usage.inputTokens ?? 0,
            completionTokens: result.usage.outputTokens ?? 0,
            thinking: result.reasoningText || filtered.thinking || null,
          }
        }
        const postBase = {
          settings: settings as never,
          workspaceDir: ws,
          sessionId: payload.session_id ?? null,
          characterMessage,
          availableFiles: payload.available_files,
          readFile,
          defaultMaxTokens: null,
          signal,
          onEvent: sendPostEvent,
          generatePass,
        }

        if (harness && harness !== 'none') {
          send({ status: 'generating' })
          let activePath: string | null = null
          if (payload.active_filename) {
            activePath =
              payload.available_files.find((f) => f.name === payload.active_filename)?.path ?? null
            if (!isPlanner && activePath && payload.content) {
              try {
                await writeWorkspaceFile(activePath, payload.content, ws)
              } catch (e) {
                console.warn(`Harness pre-flush failed for ${activePath}: ${errMsg(e)}`)
              }
            }
          }
          let harnessPrompt = ''
          if (isPlanner) {
            const deps = {
              settings: settings as never,
              plannerPrompt: await loadSimplePrompt('scene-planner.md').catch(() => ''),
              readFile: (p: string) => readWorkspaceFile(p, ws).catch(() => null),
              includeHistory: false,
              expandedTagged: tagged,
            }
            const composed = await composeScenePlannerMessages(payload, deps as never)
            const idx = await workspaceIndexLine(ws).catch(() => '')
            const built = buildHarnessChatPrompt({
              system: composed.system,
              userMessage: composed.files ? `${composed.files}\n\n${composed.user}` : composed.user,
              characterMessage,
              indexLine: idx || undefined,
            })
            systemPrompt = built.system
            userPrompt = built.user
            harnessPrompt = built.harnessPrompt
            console.log(formatCacheInfo('scene_planner_harness', systemPrompt, userPrompt))
          } else if (mode === 'edit') {
            send({ status: 'context_resolved', context_needed: [] })
            const idx = await workspaceIndexLine(ws).catch(() => '')
            const built = buildHarnessEditPrompt({
              activePath,
              selectedText: payload.selected_text,
              cursorParagraphText: payload.cursor_paragraph_text,
              taggedFiles: tagged,
              characterMessage,
              instruction: payload.message,
              indexLine: idx || undefined,
              systemPrompt: await loadSimplePrompt('harness-edit.md').catch(() => ''),
            })
            systemPrompt = built.system
            userPrompt = built.user
            harnessPrompt = built.harnessPrompt
            console.log(formatCacheInfo('harness_edit', systemPrompt, userPrompt))
          } else {
            const req = { ...payload, message: requestMessage }
            const deps = {
              settings: settings as never,
              chatPrompt: await loadSimplePrompt('simple-chat.md').catch(() => ''),
              readFile: (p: string) => readWorkspaceFile(p, ws).catch(() => null),
              message: requestMessage,
              includeHistory: false,
              expandedTagged: tagged,
            }
            const composed = await composeChatMessages(req as never, deps as never)
            const idx = await workspaceIndexLine(ws).catch(() => '')
            const built = buildHarnessChatPrompt({
              system: composed.system,
              userMessage: composed.files ? `${composed.files}\n\n${composed.user}` : composed.user,
              characterMessage,
              indexLine: idx || undefined,
            })
            systemPrompt = built.system
            userPrompt = built.user
            harnessPrompt = built.harnessPrompt
            console.log(formatCacheInfo('harness_chat', systemPrompt, userPrompt))
          }
          const resumeId = payload.session_id ? await getHarnessSession(payload.session_id, harness) : null
          const overrides = ((settings.harnesses ?? {}) as Record<string, { executable?: string; model?: string }>)
          const desc = HARNESS_DESCRIPTORS[harness]
          let fullOutput = ''
          let fullThinking = ''
          let usagePrompt = 0
          let usageCompletion = 0
          let sawErrorText = false
          const toolCalls: unknown[] = []
          const outcome = await runHarness({
            harnessId: harness,
            prompt: harnessPrompt,
            cwd: ws,
            mode: harnessMode,
            resumeId,
            overrides,
            signal,
            onItems: (items) => {
              for (const [qtype, qval] of items) {
                if (qtype === 'chunk' && typeof qval === 'string') {
                  const clean = stripAnsi(qval)
                  fullOutput += clean
                  send({ status: 'chunk', chunk: clean })
                } else if (qtype === 'thinking' && typeof qval === 'string') {
                  fullThinking += qval
                  send({ status: 'thinking_chunk', chunk: qval })
                } else if (qtype === 'tool' && typeof qval === 'object' && qval !== null) {
                  const t = qval as { tool: string; detail: string; path: string | null }
                  toolCalls.push(t)
                  const rel = t.path ? toolEventPath(ws, { input: { path: t.path } }) : ''
                  const toolEvt: Record<string, string> = { status: 'tool', tool: t.tool, detail: t.detail }
                  if (rel) toolEvt.path = rel
                  else if (t.path) toolEvt.path = t.path
                  send(toolEvt)
                } else if (qtype === 'usage' && typeof qval === 'object' && qval !== null) {
                  const u = qval as { prompt_tokens?: number; completion_tokens?: number }
                  usagePrompt += u.prompt_tokens ?? 0
                  usageCompletion += u.completion_tokens ?? 0
                } else if (qtype === 'error_text' && typeof qval === 'string') {
                  sawErrorText = true
                  fullOutput += (fullOutput ? '\n' : '') + qval
                  send({ status: 'chunk', chunk: '\n' + qval })
                }
              }
            },
          })
          if (outcome.code !== 0 && outcome.code !== null) {
            if (resumeId && payload.session_id) await clearHarnessSession(payload.session_id, harness)
            const failure = outcome.error
              ? `${desc?.name ?? harness} failed: ${outcome.error}`
              : `${desc?.name ?? harness} exited with code ${outcome.code}. Last output:\n${fullOutput.trim().split('\n').slice(-5).join('\n').trim() || 'no output captured'}`
            throw new Error(failure)
          }
          if (!usagePrompt && harnessPrompt) usagePrompt = Math.max(1, Math.floor(harnessPrompt.length / 4))
          if (!usageCompletion && fullOutput) usageCompletion = Math.max(1, Math.floor(fullOutput.length / 4))
          if (outcome.sessionId && payload.session_id) await setHarnessSession(payload.session_id, harness, outcome.sessionId)
          const runOk = !sawErrorText
          let harnessPost: HarnessPostProcessResult | null = null
          if (!isPlanner && mode === 'edit' && activePath && runOk && !signal.aborted) {
            try {
              const after = (await readWorkspaceFile(activePath, ws)) ?? ''
              if (after && after !== payload.content) {
                harnessPost = await runHarnessPostProcess({
                  ...postBase,
                  upstreamSystemPrompt: systemPrompt,
                  upstreamInstruction: payload.message,
                  before: payload.content,
                  after,
                  filePath: activePath,
                })
                if (!signal.aborted && !harnessPost.skipped && harnessPost.text !== after) {
                  await writeWorkspaceFile(activePath, harnessPost.text, ws)
                }
              }
            } catch (error) {
              console.warn(`Harness post-processing failed for ${activePath}: ${errMsg(error)}`)
            }
          }
          const harnessPostLog =
            harnessPost &&
            !(harnessPost.skipped && ['disabled', 'no_passes'].includes(harnessPost.reason ?? ''))
              ? {
                  source: 'harness',
                  file: activePath,
                  skipped: harnessPost.skipped,
                  reason: harnessPost.reason ?? null,
                  hunks: harnessPost.hunks,
                  skipped_hunks: harnessPost.skippedHunks,
                  passes: harnessPost.passes,
                  snapshots: harnessPost.snapshots,
                }
              : null
          await saveSimpleAiLog({
            mode: isPlanner ? 'planner' : mode === 'chat' ? 'chat' : 'edit_write',
            session_id: payload.session_id,
            system_prompt: isServiceTransport(harness)
              ? systemPrompt
              : resolveHarnessArgv(harness, harnessPrompt, ws, harnessMode, resumeId, overrides)
                  .map((a) => (a.length < 60 ? a : a.slice(0, 60) + '…')).join(' '),
            user_prompt: harnessPrompt,
            output: fullOutput,
            instruction: payload.message,
            selected_text: payload.selected_text,
            ref_files: null,
            success: runOk,
            prompt_tokens: usagePrompt,
            completion_tokens: usageCompletion,
            total_tokens: usagePrompt + usageCompletion,
            thinking_output: fullThinking || null,
            tool_calls: toolCalls.length ? toolCalls : null,
            model_used: `${harness}:${String(overrides[harness]?.model ?? 'default')}`,
            system_hash: prefixHash(systemPrompt),
            user_hash: prefixHash(harnessPrompt),
            post_processing: harnessPostLog,
          }, ws)
          if (isPlanner) {
            send({
              status: 'planner',
              harness,
              output: fullOutput,
              thinking_output: fullThinking || null,
              prompt_tokens: usagePrompt,
              completion_tokens: usageCompletion,
              model_used: `${harness}:${String(overrides[harness]?.model ?? 'default')}`,
            })
          } else {
            send({ status: 'harness_done', harness, post_processing: harnessPostLog })
          }
          c.close()
          return
        }

        const client = loadLlmConfig(settings as never, payload.endpoint_id)

        if (isPlanner || isPlannerDraft) {
          send({ status: 'generating' })
          const promptName = isPlannerDraft ? 'scene-drafter.md' : 'scene-planner.md'
          const plannerPrompt = await loadSimplePrompt(promptName).catch(() => '')
          const plannerLogs = isPlannerDraft
            ? plannerSessionLogs
            : await getWorkspaceAiLogs(ws, payload.session_id).catch(() => [])
          const composed = await composeScenePlannerMessages(payload, {
            settings: settings as never,
            plannerPrompt,
            readFile,
            logs: plannerLogs as never,
            expandedTagged: tagged,
            historyMode: ['planner', 'planner_draft'],
          })
          systemPrompt = composed.system
          const plannerMsgs = assembleAssistMessages(
            systemPrompt,
            composed.history,
            composed.files,
            composed.user,
            characterMessage,
          )
          userPrompt = plannerMsgs.fullUser
          const plannerCache = cacheOptsForSession(settings as never, payload.session_id, systemPrompt)
          const logMode = isPlannerDraft ? 'planner_draft' : 'planner'
          console.log(formatCacheInfo(`scene_${logMode}`, systemPrompt, userPrompt, { slotId: plannerCache.slotId }))
          const availableForAgent = payload.available_files
          const agent = isPlannerDraft
            ? createSceneDraftingAgent({
                endpoint: client,
                instructions: composed.system,
              })
            : createScenePlannerAgent({
                endpoint: client,
                instructions: composed.system,
                availableFiles: availableForAgent,
                readFile,
                memory: { workspaceKey: ws, config: memoryConfig(process.env, settings) },
              })
          let fullPlanner = ''
          let fullThinking = ''
          let promptTokens = 0
          let totalPromptTokens = 0
          let completionTokens = 0
          const toolCalls: Array<Record<string, unknown>> = []
          const agentResult = await agent.stream({
            messages: plannerMsgs.messages.filter((message) => message.role !== 'system') as ModelMessage[],
            abortSignal: signal,
            onToolExecutionStart: ({ toolCall }) => {
              const call = toolCall as { toolName?: unknown; input?: unknown }
              const toolName = typeof call.toolName === 'string' ? call.toolName : 'tool'
              const input =
                typeof call.input === 'object' && call.input !== null
                  ? (call.input as Record<string, unknown>)
                  : {}
              const path = typeof input.path === 'string' ? input.path : ''
              toolCalls.push({ tool: toolName, path: path || null })
              send({
                status: 'tool',
                tool: toolName,
                detail: path ? `Reading ${path}` : 'Reading workspace context',
                ...(path ? { path } : {}),
              })
            },
            onStepEnd: ({ usage }) => {
              const stepInputTokens = usage.inputTokens ?? 0
              promptTokens = Math.max(promptTokens, stepInputTokens)
              totalPromptTokens += stepInputTokens
              completionTokens += usage.outputTokens ?? 0
            },
          })
          for await (const part of agentResult.fullStream) {
            if (signal.aborted) break
            if (part.type === 'text-delta') {
              fullPlanner += part.text
              send({ status: 'chunk', chunk: part.text })
            } else if (part.type === 'reasoning-delta') {
              fullThinking += part.text
              send({ status: 'thinking_chunk', chunk: part.text })
            }
          }
          const output = (await agentResult.text).trim() || fullPlanner
          const refFiles = tagged.map((path) => ({
            path,
            name: payload.available_files.find((file) => file.path === path)?.name ?? path.split('/').pop() ?? path,
          }))
          await saveSimpleAiLog({
            mode: logMode,
            session_id: payload.session_id,
            system_prompt: systemPrompt,
            user_prompt: userPrompt,
            output,
            raw_output: output,
            instruction: payload.message,
            selected_text: payload.selected_text,
            ref_files: refFiles,
            success: true,
            prompt_tokens: totalPromptTokens,
            context_prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalPromptTokens + completionTokens,
            thinking_output: fullThinking || null,
            tool_calls: toolCalls.length ? toolCalls : null,
            model_used: client.lastModelUsed,
            system_hash: prefixHash(systemPrompt),
            user_hash: prefixHash(userPrompt),
            prompt_ms: null,
            tokens_cached: null,
            slot_id: plannerCache.slotId ?? null,
          }, ws)
          send({
            status: 'planner',
            agent_role: isPlannerDraft ? 'drafter' : 'planner',
            output,
            thinking_output: fullThinking || null,
            prompt_tokens: promptTokens,
            total_prompt_tokens: totalPromptTokens,
            completion_tokens: completionTokens,
            model_used: client.lastModelUsed,
          })
          c.close()
          return
        }

        if (mode === 'write') {
          const pending = payload.clarification_id
            ? getPendingWriteClarification(payload.clarification_id, payload.session_id)
            : null
          if (payload.clarification_id && !pending) {
            throw new Error('That clarification request expired or is no longer available. Please retry the write request.')
          }
          if (pending && pending.originalMessage !== payload.message) {
            throw new Error('The clarification request does not match this writing prompt.')
          }

          let context = pending?.context ?? ''
          let clarificationMessages: ModelMessage[] = []
          let clarificationAnswers: Record<string, string> = pending?.answers ?? {}
          const clarificationRound = pending?.rounds ?? 0

          if (pending) {
            const questions = normalizeWriteClarificationQuestions(pending.toolInput)
            if (!questions.length) throw new Error('The pending clarification request is invalid.')
            const submitted = validateWriteClarificationAnswers(
              questions,
              payload.clarification_answers ?? payload.write_answers,
            )
            if (!takePendingWriteClarification(pending.id, payload.session_id)) {
              throw new Error('That clarification request has already been submitted.')
            }
            claimedWriteClarification = pending
            clarificationAnswers = { ...clarificationAnswers, ...submitted.byQuestion }
            const pendingCalls = pending.toolCalls ?? [{ toolCallId: pending.toolCallId, toolInput: pending.toolInput }]
            clarificationMessages = [
              ...(pending.messages as ModelMessage[]),
              {
                role: 'tool',
                content: pendingCalls.map((call) => {
                  const callQuestions = normalizeWriteClarificationQuestions(call.toolInput)
                  const answers = Object.fromEntries(callQuestions.map((question) => [question.id, submitted.byId[question.id]]))
                  return {
                    type: 'tool-result' as const,
                    toolCallId: call.toolCallId,
                    toolName: 'ask_user',
                    input: call.toolInput,
                    output: { type: 'json' as const, value: { answers } },
                  }
                }),
              } as ModelMessage,
            ]
          } else {
            const referenceContext: string[] = []
            let referenceChars = 0
            for (const path of tagged.slice(0, 8)) {
              if (referenceChars >= 24000) break
              const fileContent = await readFile(path)
              if (!fileContent) continue
              const excerpt = fileContent.slice(0, Math.min(8000, 24000 - referenceChars))
              referenceContext.push(`Referenced file: ${path}\n${excerpt}`)
              referenceChars += excerpt.length
            }
            context = [
              `User request:\n${payload.message}`,
              characterMessage ? `Character context:\n${characterMessage}` : '',
              payload.selected_text ? `Selected passage:\n${payload.selected_text}` : '',
              payload.content ? `Current document:\n${payload.content.slice(-30000)}` : '',
              referenceContext.length ? `Referenced context:\n${referenceContext.join('\n\n')}` : '',
            ].filter(Boolean).join('\n\n')
            clarificationMessages = [{
              role: 'user',
              content: `Decide whether to ask any clarifying questions before starting the writing plan.\n\n${context}`,
            }]
            // Compatibility for clients that already send answers without a
            // pending tool call: carry those answers into the write context.
            if (questionnaireAnswers && answerLines.length) {
              clarificationAnswers = Object.fromEntries(
                Object.entries(questionnaireAnswers).map(([key, value]) => [
                  key,
                  Array.isArray(value) ? value.join(', ') : value,
                ]),
              )
            }
          }

          if (!pending && Object.keys(clarificationAnswers).length === 0) {
            send({ status: 'write_clarifying' })
          } else if (pending) {
            send({ status: 'write_clarifying', continuation: true })
          }
          if (pending || Object.keys(clarificationAnswers).length === 0) {
            const clarificationMemoryConfig = memoryConfig(process.env, settings)
            const clarificationAgent = createWriteClarificationAgent({
              endpoint: {
                model: client.model,
                baseUrl: client.baseUrl,
                apiKey: client.apiKey,
                requestBody: {
                  // This is a structured tool-call gate, not a prose stage. Some
                  // reasoning models can consume the entire output budget in
                  // reasoning_content and return no ask_user call at all.
                  // Disable thinking so the questionnaire is emitted reliably.
                  chat_template_kwargs: { enable_thinking: false },
                },
              },
              memory: clarificationMemoryConfig.enabled
                ? { workspaceKey: ws, config: clarificationMemoryConfig }
                : undefined,
              instructions: [
                'You are the clarification gate before a multi-stage writing pipeline.',
                'Assess the request using the full supplied scene, passage, and referenced-file context.',
                'When workspace memory is available, search it before asking the user about a material missing detail that may already be recorded.',
                'If a missing decision would materially change the result, call ask_user with one questionnaire of up to four concise, specific questions. Supply two to four distinct radio options for each; the interface provides a freeform Other option.',
                'Do not ask about details already stated, safely inferable, or answered by relevant memory. Do not ask merely to optimize minor preferences.',
                'After answers resolve the important ambiguity, call proceed_to_plan. If the request is already actionable, call proceed_to_plan immediately.',
                'Call exactly one tool per turn. Do not write the scene or start planning yourself.',
              ].join(' '),
            })
            const clarification = await clarificationAgent.generate({
              messages: clarificationMessages,
              abortSignal: signal,
            })
            const askCalls = clarification.toolCalls.filter((call) => call.toolName === 'ask_user')
            const askCall = askCalls[0]
            if (askCall) {
              // Prefer an explicit questionnaire when a small model emits both
              // tools in one turn. Asking is the safe, reversible action;
              // proceeding would silently discard the unanswered questions.
              const questionnaireCalls = askCalls.flatMap((call) => {
                const questions = normalizeWriteClarificationQuestions(call.input)
                return questions.length ? [{ call, questions }] : []
              })
              const multipleQuestionnaires = questionnaireCalls.length > 1
              const questions = questionnaireCalls.flatMap(({ questions: items }, index) => items.map((question) => ({
                ...question,
                ...(multipleQuestionnaires ? { id: `${index}_${question.id}` } : {}),
              })))
              if (!questionnaireCalls.length || questions.length > 12) {
                throw new Error('The clarifying agent returned invalid questionnaires.')
              }
              const combinedQuestions = { questions }
              if (clarificationRound >= MAX_WRITE_CLARIFICATION_ROUNDS) {
                throw new Error('The clarifying agent reached its question limit. Please refine the writing prompt and try again.')
              }
              const saved = savePendingWriteClarification({
                sessionId: payload.session_id,
                originalMessage: payload.message,
                context,
                messages: [...clarificationMessages, ...clarification.responseMessages],
                answers: clarificationAnswers,
                rounds: clarificationRound + 1,
                toolCallId: askCall.toolCallId,
                toolInput: combinedQuestions,
                toolCalls: questionnaireCalls.map(({ call, questions: items }, index) => ({
                  toolCallId: call.toolCallId,
                  toolInput: { questions: items.map((question) => ({ ...question, ...(multipleQuestionnaires ? { id: `${index}_${question.id}` } : {}) })) },
                })),
              })
              claimedWriteClarification = null
              send({
                status: 'write_questionnaire',
                clarification_id: saved.id,
                questions,
              })
              c.close()
              return
            }
            const clarificationFinishReason =
              clarification.rawFinishReason ?? clarification.finishReason ?? null
            if (clarificationFinishReason === 'length') {
              throw new Error(
                'The clarification agent ran out of output before asking its question. Please retry the writing request.',
              )
            }
            if (!clarification.toolCalls.some((call) => call.toolName === 'proceed_to_plan')) {
              throw new Error(
                'The clarification agent did not complete its decision. Please retry the writing request.',
              )
            }
          }

          claimedWriteClarification = null
          if (Object.keys(clarificationAnswers).length) {
            context += `\n\nClarification answers:\n${JSON.stringify(clarificationAnswers)}`
          }

          const evaluateProse = payload.evaluate_prose ?? (settings.write_evaluation_enabled !== false)
          let allThinking = ''
          let finalOutput = ''
          let proseLogprobs: number[] | null = null
          let originalDraftForLog = ''
          let writingEvaluation: WritingEvaluationRecord = evaluateProse
            ? { status: 'skipped', reason: 'not_run' }
            : { status: 'skipped', reason: 'disabled' }
          send({ status: 'write_started', stages: WRITING_PIPELINE_STAGES.map((stage) => stage.id) })
          const pipeline = await runWritingPipeline({
            context,
            signal,
            onStageStart: (stage) => send({ status: 'write_stage_started', stage: stage.id }),
            onStageComplete: (stage, output) => send({
              status: 'write_stage_completed',
              stage: stage.id,
              output: stage.id === 'prose' ? undefined : output,
            }),
            generate: async (stage, prompt) => {
              const id = stage.id
              if (signal.aborted) return ''
              let output = ''
              let stageThinking = ''
              const stageTelemetry: AssistAgentTelemetry = {
                timings: null,
                tokensCached: null,
                pending: null,
                tokenLogprobs: [],
                onReasoningDelta: (delta) => {
                  stageThinking += delta
                  allThinking += delta
                  send({ status: 'write_reasoning', stage: id, chunk: delta })
                },
              }
              const agent = createWriteStageAgent({
                endpoint: {
                  model: client.model,
                  baseUrl: client.baseUrl,
                providerName: client.providerName,
                  apiKey: client.apiKey,
                  telemetry: stageTelemetry,
                  requestBody: {
                    chat_template_kwargs: {
                      enable_thinking: client.isThinking,
                    },
                  },
                },
                instructions: stage.agentInstructions,
                temperature: stage.temperature,
                // Internal notes stay bounded, but the final prose stage is
                // intentionally uncapped; the provider's context window remains
                // the hard limit.
                ...(stage.maxOutputTokens == null
                  ? {}
                  : {
                      maxOutputTokens: generationBudget(
                        stage.maxOutputTokens,
                        client.isThinking,
                        prompt.length,
                        getActiveContextWindow(settings as never),
                      ),
                    }),
              })
              const result = await agent.stream({
                messages: [{ role: 'user', content: prompt }],
                abortSignal: signal,
                ...(id === 'prose' ? { providerOptions: logprobProviderOptions(client.providerName) } : {}),
              })
              const thinkingFilter = new ThinkingTagFilter(
                client.isThinking,
                client.customOpeningTags,
                client.customClosingTags,
              )
              for await (const part of result.fullStream) {
                if (signal.aborted) break
                if (part.type === 'text-delta') {
                  const filtered = thinkingFilter.push(part.text)
                  if (filtered.thinking) {
                    stageThinking += filtered.thinking
                    allThinking += filtered.thinking
                    send({ status: 'write_reasoning', stage: id, chunk: filtered.thinking })
                  }
                  if (filtered.text) {
                    output += filtered.text
                    if (id === 'prose') send({ status: 'write_prose', chunk: filtered.text })
                  }
                }
                if (id === 'prose' && part.type === 'finish-step') {
                  proseLogprobs = extractTokenLogprobs(part.providerMetadata, client.providerName) ?? proseLogprobs
                }
              }
              const filteredTail = thinkingFilter.flush()
              if (filteredTail.thinking) {
                stageThinking += filteredTail.thinking
                allThinking += filteredTail.thinking
                send({ status: 'write_reasoning', stage: id, chunk: filteredTail.thinking })
              }
              if (filteredTail.text) {
                output += filteredTail.text
                if (id === 'prose') send({ status: 'write_prose', chunk: filteredTail.text })
              }
              await stageTelemetry.pending
              if (id === 'prose' && stageTelemetry.tokenLogprobs?.length) {
                proseLogprobs = stageTelemetry.tokenLogprobs
              }
              const resultReasoning = await result.reasoningText
              if (resultReasoning && !stageThinking) {
                stageThinking = resultReasoning
                allThinking += resultReasoning
                send({ status: 'write_reasoning', stage: id, chunk: resultReasoning })
              }
              output = output.trim() || (await result.text).trim()
              if (id === 'prose') finalOutput = output
              return output
            },
          })
          finalOutput = pipeline.output
          originalDraftForLog = finalOutput

          if (!signal.aborted) {
            if (evaluateProse) {
              send({ status: 'write_evaluation_started' })
              try {
                const anchor = extractAnchorContext(
                  payload.content,
                  payload.selected_text,
                  payload.cursor_paragraph_text,
                )
                let deterministicChecks = evaluateDraftDeterministically({
                  draft: finalOutput,
                  paragraphBefore: anchor.paragraphBefore,
                  paragraphAfter: anchor.paragraphAfter,
                })
                let predictablePattern = attachPerplexity(evaluatePredictablePatterns(finalOutput), proseLogprobs)
                let styleChecks = payload.english_style_checker_enabled
                  ? checkEnglishStyle({ draft: finalOutput })
                  : null
                let modelReview: WritingModelReview | null = null
                const contextWindow = getActiveContextWindow(settings as never)
                const evaluatorMaxTokens = contextWindow
                  ? Math.min(1400, Math.max(800, Math.floor(contextWindow * 0.3)))
                  : 1400
                const evaluationInputChars = contextWindow
                  ? Math.min(48_000, Math.max(2_800, (contextWindow - evaluatorMaxTokens - 600) * 4))
                  : 48_000
                let revisionIterations = 0
                // Evaluate the current draft again after each automatic fix.
                // The hard limit prevents noisy findings from causing an
                // unbounded rewrite loop.
                while (!signal.aborted) {
                  modelReview = null
                  if (finalOutput.trim()) {
                    const prompt = buildWritingEvaluationPrompt({
                      instruction: requestMessage,
                      plan: pipeline.artifacts.find((artifact) => artifact.stage === 'plan')?.content,
                      context,
                      draft: finalOutput,
                      maxInputChars: evaluationInputChars,
                    })
                    const evaluator = createWriteEvaluationAgent({
                      endpoint: {
                        model: client.model,
                        baseUrl: client.baseUrl,
                        apiKey: client.apiKey,
                        requestBody: { chat_template_kwargs: { enable_thinking: false } },
                      },
                      instructions: 'Return only the requested JSON review. Be evidence-based, conservative, and advisory. Never rewrite the draft.',
                      maxOutputTokens: evaluatorMaxTokens,
                    })
                    const evaluationSignal = AbortSignal.any([signal, AbortSignal.timeout(45_000)])
                    const evaluation = await evaluator.generate({ prompt, abortSignal: evaluationSignal })
                    modelReview = parseWritingModelReview(evaluation.text)
                  }

                  deterministicChecks = evaluateDraftDeterministically({
                    draft: finalOutput,
                    paragraphBefore: anchor.paragraphBefore,
                    paragraphAfter: anchor.paragraphAfter,
                  })
                  predictablePattern = attachPerplexity(
                    evaluatePredictablePatterns(finalOutput),
                    revisionIterations === 0 ? proseLogprobs : null,
                  )
                  styleChecks = payload.english_style_checker_enabled
                    ? checkEnglishStyle({ draft: finalOutput })
                    : null

                  const actionableFindings = [
                    ...deterministicChecks.filter(check => check.status !== 'pass'),
                    ...(modelReview?.findings ?? []),
                    ...predictablePattern.spans,
                    ...(styleChecks?.checks ?? []).filter(check => check.status === 'warning'),
                  ]
                  if (!actionableFindings.length || revisionIterations >= 3 || signal.aborted) break

                  const rewriter = createWriteEvaluationAgent({
                    endpoint: {
                      model: client.model,
                      baseUrl: client.baseUrl,
                      apiKey: client.apiKey,
                      requestBody: { chat_template_kwargs: { enable_thinking: false } },
                    },
                    instructions: 'Return only the complete revised passage. Apply every supported editorial finding while preserving facts, voice, and meaning. Leave conventional dialogue, simple actions, and intentional stylistic choices unchanged unless a concrete issue is identified.',
                    maxOutputTokens: 1800,
                  })
                  const revision = await rewriter.generate({
                    prompt: buildAutomaticProseRevisionPrompt({
                      draft: finalOutput,
                      instruction: requestMessage,
                      modelReview,
                      deterministicChecks,
                      predictablePattern,
                      styleChecks,
                    }),
                    abortSignal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
                  })
                  const revised = revision.text.trim()
                  if (!revised || revised === finalOutput) break
                  finalOutput = revised
                  revisionIterations += 1
                  send({ status: 'write_rewrite_candidate', output: finalOutput, iterations: revisionIterations })
                }
                const result: WritingEvaluationResult = {
                  version: 1,
                  deterministicChecks,
                  modelReview,
                  predictablePattern,
                  styleChecks,
                }
                writingEvaluation = { status: 'complete', result }
                send({ status: 'write_evaluation_completed', evaluation: result })
              } catch (error) {
                if (!signal.aborted) {
                  console.warn(`Writing evaluation unavailable: ${errMsg(error)}`)
                  writingEvaluation = {
                    status: 'failed',
                    message: 'Evaluation could not produce a valid report. The draft is still available to review.',
                  }
                  send({ status: 'write_evaluation_failed', message: writingEvaluation.message })
                }
              }
            } else {
              send({ status: 'write_evaluation_skipped', reason: 'disabled' })
            }
          }
          if (!signal.aborted) {
            await saveSimpleAiLog({
              mode: 'write',
              session_id: payload.session_id,
              system_prompt: `Write pipeline: ${WRITING_PIPELINE_STAGES.map((stage) => stage.id).join(', ')}.`,
              user_prompt: context,
              output: finalOutput,
               raw_output: originalDraftForLog || finalOutput,
              instruction: payload.message,
              selected_text: payload.selected_text,
              ref_files: tagged.map(path => ({
                path,
                name: payload.available_files.find(file => file.path === path)?.name ?? path.split('/').pop() ?? path,
              })),
              success: Boolean(finalOutput),
              thinking_output: allThinking || null,
              writing_evaluation: writingEvaluation,
              model_used: client.lastModelUsed,
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0
            }, ws)
            send({ status: 'write_completed', output: finalOutput })
          }
          c.close()
          return
        }

        const isEditFlow = mode === 'edit'
        const agentEndpoint = {
          model: client.model,
          baseUrl: client.baseUrl,
          apiKey: client.apiKey,
        }
        const cacheRequestBody = (cache: {
          cachePrompt: boolean
          nKeep: number
          slotId?: number
        }) => ({
          cache_prompt: cache.cachePrompt,
          n_keep: cache.nKeep,
          chat_template_kwargs: {
            enable_thinking: client.isThinking,
          },
          ...(cache.slotId != null ? { id_slot: cache.slotId } : {}),
        })

        type PlannerRun = {
          system: string
          user: string
          raw: string
          plan: ReturnType<typeof parsePlannerOutput>
          promptTokens: number
          completionTokens: number
          thinking: string | null
          model: string
        }
        type EditRun = {
          raw: string
          clean: string
          system: string
          user: string
          promptTokens: number
          completionTokens: number
          thinking: string | null
          model: string
          promptMs: number | null
          tokensCached: number | null
          anchor: ReturnType<typeof extractAnchorContext>
          slotId: number | null
        }
        type ChatRun = {
          raw: string
          system: string
          user: string
          promptTokens: number
          completionTokens: number
          thinking: string | null
          model: string
          promptMs: number | null
          tokensCached: number | null
          anchor: ReturnType<typeof extractAnchorContext> | null
          slotId: number | null
          logs: Awaited<ReturnType<typeof getWorkspaceAiLogs>>
        }

        let plannerRun: PlannerRun | null = null
        let editRun: EditRun | null = null
        let chatRun: ChatRun | null = null
        let plannerPromise: Promise<PlannerRun | null> | null = null
        let editPromise: Promise<EditRun> | null = null
        let chatPromise: Promise<ChatRun> | null = null
        let postProcessPromise: Promise<void> | null = null
        let finalized = false
        const taggedContext = [...tagged]

        function runPlanner(announce: boolean): Promise<PlannerRun | null> {
          if (payload.skip_planner) return Promise.resolve(null)
          if (plannerRun) return Promise.resolve(plannerRun)
          if (!plannerPromise) plannerPromise = performPlanner(announce)
          return plannerPromise
        }

        async function performPlanner(announce: boolean): Promise<PlannerRun | null> {
          if (payload.skip_planner) return null
          if (plannerRun) return plannerRun
          if (announce) send({ status: 'planning' })
          const plannerPrompt = await loadSimplePrompt('simple-planner.md').catch(() => '')
          const historyLogs = await getWorkspaceAiLogs(ws, payload.session_id).catch(() => [])
          const manifests = await collectManifestSections(
            ws,
            (settings as { ignored_ref_files?: string[] }).ignored_ref_files ?? [],
          ).catch(() => [])
          const planner = runPlannerPrompt({
            content: payload.content,
            message: requestMessage,
            selectedText: payload.selected_text,
            cursorParagraphText: payload.cursor_paragraph_text,
            sessionId: payload.session_id,
            taggedFiles: tagged,
            settings: settings as never,
            logs: historyLogs as never,
            manifests,
            plannerPrompt,
          })
          systemPrompt = planner.system
          const plannerMsgs = assembleAssistMessages(
            systemPrompt,
            [],
            null,
            planner.user,
            characterMessage,
          )
          userPrompt = plannerMsgs.fullUser
          const plannerCache = cacheOptsForSession(
            settings as never,
            payload.session_id,
            systemPrompt,
          )
          console.log(
            formatCacheInfo('planner', systemPrompt, userPrompt, {
              slotId: plannerCache.slotId,
            }),
          )
          const agent = createAssistPlannerAgent({
            endpoint: { ...agentEndpoint, requestBody: cacheRequestBody(plannerCache) },
            instructions: planner.system,
            maxOutputTokens: generationBudget(
              800,
              client.isThinking,
              messageChars(plannerMsgs.messages),
              getActiveContextWindow(settings as never),
            ),
            memory: { workspaceKey: ws, config: memoryConfig(process.env, settings) },
          })
          const result = await agent.generate({
            messages: plannerMsgs.messages.filter(
              (message) => message.role !== 'system',
            ) as ModelMessage[],
            abortSignal: signal,
          })
          const filteredPlan = splitThinkingTags(
            result.text,
            client.isThinking,
            client.customOpeningTags,
            client.customClosingTags,
          )
          const planRaw = filteredPlan.text.trim()
          const run: PlannerRun = {
            system: planner.system,
            user: userPrompt,
            raw: planRaw,
            plan: parsePlannerOutput(planRaw, requestMessage),
            promptTokens: result.usage.inputTokens ?? 0,
            completionTokens: result.usage.outputTokens ?? 0,
            thinking: result.reasoningText || filteredPlan.thinking || null,
            model: result.response.modelId || client.model,
          }
          plannerRun = run
          const contextNeeded: string[] = [...(run.plan.context_needed ?? [])]
          for (const p of taggedContext) {
            if (!contextNeeded.includes(p)) contextNeeded.push(p)
          }
          send({ status: 'context_resolved', context_needed: contextNeeded })
          return run
        }

        function runEdit(): Promise<EditRun> {
          if (editRun) return Promise.resolve(editRun)
          if (!editPromise) editPromise = performEdit()
          return editPromise
        }

        async function performEdit(): Promise<EditRun> {
          if (editRun) return editRun
          const plan = payload.skip_planner ? null : await runPlanner(true)
          if (!plan) {
            send({ status: 'context_resolved', context_needed: taggedContext })
          }
          send({ status: 'generating' })
          const query = plan?.plan.refined_query || requestMessage
          const contextNeeded: string[] = plan
            ? [...(plan.plan.context_needed ?? [])]
            : [...taggedContext]
          for (const p of taggedContext) {
            if (!contextNeeded.includes(p)) contextNeeded.push(p)
          }
          const anchor = extractAnchorContext(
            payload.content,
            payload.selected_text,
            payload.cursor_paragraph_text,
          )
          const writerPrompt = await loadSimplePrompt('simple-writer.md').catch(() => '')
          const gen = await buildGeneratorPrompts({
            paragraphBefore: anchor.paragraphBefore,
            targetParagraph: anchor.targetParagraph,
            paragraphAfter: anchor.paragraphAfter,
            query,
            contextNeeded,
            availableFiles: payload.available_files,
            settings: settings as never,
            writerPrompt,
            readFile,
          })
          systemPrompt = gen.system
          const writerMsgs = assembleAssistMessages(
            systemPrompt,
            [],
            gen.files,
            gen.user,
            characterMessage,
          )
          userPrompt = writerMsgs.fullUser
          const writerCache = cacheOptsForSession(
            settings as never,
            payload.session_id,
            systemPrompt,
          )
          console.log(
            formatCacheInfo('writer', systemPrompt, userPrompt, {
              slotId: writerCache.slotId,
            }),
          )
          const writerTelemetry: AssistAgentTelemetry = {
            timings: null,
            tokensCached: null,
            pending: null,
          }
          const agent = createAssistEditAgent({
            endpoint: {
              ...agentEndpoint,
              requestBody: cacheRequestBody(writerCache),
              telemetry: writerTelemetry,
            },
            instructions: gen.system,
          })
          let fullRaw = ''
          let fullThinking = ''
          const thinkingFilter = new ThinkingTagFilter(
            client.isThinking,
            client.customOpeningTags,
            client.customClosingTags,
          )
          const result = await agent.stream({
            messages: writerMsgs.messages.filter(
              (message) => message.role !== 'system',
            ) as ModelMessage[],
            abortSignal: signal,
          })
          for await (const part of result.fullStream) {
            if (signal.aborted) break
            if (part.type === 'text-delta') {
              const filtered = thinkingFilter.push(part.text)
              if (filtered.text) {
                fullRaw += filtered.text
                send({ status: 'chunk', chunk: filtered.text })
              }
              if (filtered.thinking) {
                fullThinking += filtered.thinking
                send({ status: 'thinking_chunk', chunk: filtered.thinking })
              }
            } else if (part.type === 'reasoning-delta') {
              if (client.isThinking) {
                fullThinking += part.text
                send({ status: 'thinking_chunk', chunk: part.text })
              } else {
                fullRaw += part.text
                send({ status: 'chunk', chunk: part.text })
              }
            }
          }
          const filteredTail = thinkingFilter.flush()
          if (filteredTail.text) {
            fullRaw += filteredTail.text
            send({ status: 'chunk', chunk: filteredTail.text })
          }
          if (filteredTail.thinking) {
            fullThinking += filteredTail.thinking
            send({ status: 'thinking_chunk', chunk: filteredTail.thinking })
          }
          const editReasoning = await result.reasoningText
          if (editReasoning && !fullThinking) {
            fullThinking = editReasoning
            send({ status: 'thinking_chunk', chunk: editReasoning })
          }
          await writerTelemetry.pending
          const usage = await result.usage
          const response = await result.response
          const raw = fullRaw || splitThinkingTags(
            await result.text,
            client.isThinking,
            client.customOpeningTags,
            client.customClosingTags,
          ).text
          const run: EditRun = {
            raw,
            clean: stripCodeFences(raw),
            system: gen.system,
            user: writerMsgs.fullUser,
            promptTokens: usage.inputTokens ?? 0,
            completionTokens: usage.outputTokens ?? 0,
            thinking: fullThinking || (await result.reasoningText) || null,
            model: response.modelId || client.model,
            promptMs:
              typeof writerTelemetry.timings?.['prompt_ms'] === 'number'
                ? writerTelemetry.timings['prompt_ms'] as number
                : null,
            tokensCached: writerTelemetry.tokensCached,
            anchor,
            slotId: writerCache.slotId ?? null,
          }
          editRun = run
          return run
        }

        function runChat(): Promise<ChatRun> {
          if (chatRun) return Promise.resolve(chatRun)
          if (!chatPromise) chatPromise = performChat()
          return chatPromise
        }

        async function performChat(): Promise<ChatRun> {
          if (chatRun) return chatRun
          send({ status: 'generating' })
          const chatPrompt = await loadSimplePrompt('simple-chat.md').catch(() => '')
          const chatLogs = await getWorkspaceAiLogs(ws, payload.session_id).catch(() => [])
             const composed = await composeChatMessages({ ...payload, message: requestMessage } as never, {
             settings: settings as never,
            chatPrompt,
            readFile,
            message: requestMessage,
            logs: chatLogs as never,
             expandedTagged: tagged,
           })
           let memoryContext = ''
            try {
              memoryContext = await recallMemoryContext(ws, requestMessage, memoryConfig(process.env, settings))
              send({ status: 'memory_recall', state: memoryContext ? 'used' : 'none' })
            } catch (error) {
              console.warn(`Memory recall unavailable: ${errMsg(error)}`)
              send({ status: 'memory_recall', state: 'unavailable' })
           }
           const chatSystemPrompt = memoryContext
             ? `${composed.system}\n\n${memoryContext}`
             : composed.system
           systemPrompt = chatSystemPrompt
           const chatMsgs = assembleAssistMessages(
             chatSystemPrompt,
            composed.history,
            composed.files,
            composed.user,
            characterMessage,
          )
          userPrompt = chatMsgs.fullUser
          const chatCache = cacheOptsForSession(
            settings as never,
            payload.session_id,
            systemPrompt,
          )
          console.log(
            formatCacheInfo('chat', systemPrompt, userPrompt, {
              slotId: chatCache.slotId,
            }),
          )
          const chatTelemetry: AssistAgentTelemetry = {
            timings: null,
            tokensCached: null,
            pending: null,
          }
           const agent = createAssistChatAgent({
            endpoint: {
              ...agentEndpoint,
              requestBody: cacheRequestBody(chatCache),
              telemetry: chatTelemetry,
            },
             instructions: composed.system,
             memory: { workspaceKey: ws, config: memoryConfig(process.env, settings) },
           })
          let fullChat = ''
          let fullThinking = ''
          const thinkingFilter = new ThinkingTagFilter(
            client.isThinking,
            client.customOpeningTags,
            client.customClosingTags,
          )
          const result = await agent.stream({
            messages: chatMsgs.messages.filter(
              (message) => message.role !== 'system',
            ) as ModelMessage[],
            abortSignal: signal,
          })
          for await (const part of result.fullStream) {
            if (signal.aborted) break
            if (part.type === 'text-delta') {
              const filtered = thinkingFilter.push(part.text)
              if (filtered.text) {
                fullChat += filtered.text
                send({ status: 'chunk', chunk: filtered.text })
              }
              if (filtered.thinking) {
                fullThinking += filtered.thinking
                send({ status: 'thinking_chunk', chunk: filtered.thinking })
              }
            } else if (part.type === 'reasoning-delta') {
              if (client.isThinking) {
                fullThinking += part.text
                send({ status: 'thinking_chunk', chunk: part.text })
              } else {
                fullChat += part.text
                send({ status: 'chunk', chunk: part.text })
              }
            }
          }
          const filteredTail = thinkingFilter.flush()
          if (filteredTail.text) {
            fullChat += filteredTail.text
            send({ status: 'chunk', chunk: filteredTail.text })
          }
          if (filteredTail.thinking) {
            fullThinking += filteredTail.thinking
            send({ status: 'thinking_chunk', chunk: filteredTail.thinking })
          }
          const chatReasoning = await result.reasoningText
          if (chatReasoning && !fullThinking) {
            fullThinking = chatReasoning
            send({ status: 'thinking_chunk', chunk: chatReasoning })
          }
          await chatTelemetry.pending
          const usage = await result.usage
          const response = await result.response
          const raw = fullChat || splitThinkingTags(
            await result.text,
            client.isThinking,
            client.customOpeningTags,
            client.customClosingTags,
          ).text
          const chatAnchor =
            payload.selected_text || payload.cursor_paragraph_text
              ? extractAnchorContext(
                  payload.content,
                  payload.selected_text,
                  payload.cursor_paragraph_text,
                )
              : null
          const run: ChatRun = {
            raw,
            system: composed.system,
            user: chatMsgs.fullUser,
            promptTokens: usage.inputTokens ?? 0,
            completionTokens: usage.outputTokens ?? 0,
            thinking: fullThinking || (await result.reasoningText) || null,
            model: response.modelId || client.model,
            promptMs:
              typeof chatTelemetry.timings?.['prompt_ms'] === 'number'
                ? chatTelemetry.timings['prompt_ms'] as number
                : null,
            tokensCached: chatTelemetry.tokensCached,
            anchor: chatAnchor,
            slotId: chatCache.slotId ?? null,
            logs: chatLogs,
          }
          chatRun = run
          return run
        }

        function runPostProcess(): Promise<void> {
          if (finalized) return Promise.resolve()
          if (!postProcessPromise) postProcessPromise = performPostProcess()
          return postProcessPromise
        }

        async function performPostProcess(): Promise<void> {
          if (finalized) return

          if (isEditFlow) {
            const edit = await runEdit()
            const post = await runPostProcessPipeline({
              ...postBase,
              upstreamSystemPrompt: edit.system,
              upstreamInstruction: payload.message,
              upstreamRefinedInstruction: plannerRun?.plan.refined_query || undefined,
              text: edit.clean,
              mode: 'edit',
              anchor: edit.anchor,
            })
            const finalOutput = post.text
            const review = post.skipped ? true : postConfig.review
            await saveSimpleAiLog({
              mode: 'edit_write',
              session_id: payload.session_id,
              system_prompt: edit.system,
              user_prompt: edit.user,
              output: finalOutput,
              raw_output: edit.raw,
              post_processing:
                post.skipped && ['disabled', 'no_passes'].includes(post.reason ?? '')
                  ? null
                  : {
                      source: 'edit',
                      skipped: post.skipped,
                      reason: post.reason ?? null,
                      passes: post.passes,
                      snapshots: post.snapshots,
                    },
              instruction: payload.message,
              selected_text: payload.selected_text,
              ref_files: null,
              success: true,
              prompt_tokens: edit.promptTokens,
              completion_tokens: edit.completionTokens,
              total_tokens: edit.promptTokens + edit.completionTokens,
              thinking_output: edit.thinking,
              edit_mode: editMode,
              planner_system_prompt: plannerRun?.system ?? null,
              planner_user_prompt: plannerRun?.user ?? null,
              planner_output: plannerRun?.raw ?? null,
              cursor_paragraph_index: edit.anchor.targetIdx ?? null,
              model_used: edit.model,
              system_hash: prefixHash(edit.system),
              user_hash: prefixHash(edit.user),
              prompt_ms: edit.promptMs,
              tokens_cached: edit.tokensCached,
              slot_id: edit.slotId,
            }, ws)
            finalized = true
            send({
              status: 'applied',
              output: finalOutput,
              review,
              cursor_paragraph_index: edit.anchor.targetIdx ?? null,
              model_used: edit.model,
            })
            return
          }

          const chat = await runChat()
          const post = await runPostProcessPipeline({
            ...postBase,
            logs: chat.logs,
            upstreamSystemPrompt: chat.system,
            upstreamInstruction: payload.message,
            text: chat.raw,
            mode: 'chat',
            anchor: chat.anchor,
          })
          const finalChat = post.text
          await saveSimpleAiLog({
            mode: 'chat',
            session_id: payload.session_id,
            system_prompt: chat.system,
            user_prompt: chat.user,
            output: finalChat,
            raw_output: chat.raw,
            post_processing:
              post.skipped && ['disabled', 'no_passes'].includes(post.reason ?? '')
                ? null
                : {
                    source: 'chat',
                    skipped: post.skipped,
                    reason: post.reason ?? null,
                    passes: post.passes,
                    snapshots: post.snapshots,
                  },
            instruction: payload.message,
            selected_text: payload.selected_text,
            ref_files: null,
            success: true,
            prompt_tokens: chat.promptTokens,
            completion_tokens: chat.completionTokens,
            total_tokens: chat.promptTokens + chat.completionTokens,
            thinking_output: chat.thinking,
            model_used: chat.model,
            system_hash: prefixHash(chat.system),
            user_hash: prefixHash(chat.user),
            prompt_ms: chat.promptMs,
            tokens_cached: chat.tokensCached,
            slot_id: chat.slotId,
          }, ws)
          // Manuscript memory is updated from categorized file saves. Chat
          // responses are intentionally not treated as durable story canon.
          finalized = true
          send({ status: 'chat', output: finalChat, model_used: chat.model })
        }

        // The orchestrator only dispatches. Every tool is idempotent so a
        // retry or an out-of-order call cannot duplicate streamed output.
        const orchestratorTools: ToolSet = {
          ...(isEditFlow && !payload.skip_planner
            ? {
                plan_edit: tool({
                  description:
                    'Build the edit plan: choose context files and refine the user instruction before writing.',
                  inputSchema: z.object({}),
                  execute: async () => {
                    const run = await runPlanner(false)
                    return {
                      ok: true,
                      refined_query: run?.plan.refined_query ?? payload.message,
                      context_needed: run?.plan.context_needed ?? [],
                    }
                  },
                }),
              }
            : {}),
          ...(isEditFlow
            ? {
                write_edit: tool({
                  description:
                    'Write the edit with the editing subagent and stream it to the editor.',
                  inputSchema: z.object({}),
                  execute: async () => {
                    const run = await runEdit()
                    return { ok: true, characters: run.raw.length }
                  },
                }),
              }
            : {
                write_chat: tool({
                  description:
                    'Write the chat reply with the chat subagent and stream it to the toolbar.',
                  inputSchema: z.object({}),
                  execute: async () => {
                    const run = await runChat()
                    return { ok: true, characters: run.raw.length }
                  },
                }),
              }),
          post_process: tool({
            description:
              'Run the configured post-processing passes for the current mode. Spawns one subagent per enabled pass.',
            inputSchema: z.object({}),
            execute: async () => {
              await runPostProcess()
              return { ok: true }
            },
          }),
          finish: tool({
            description:
              'Finish the task once drafting and post-processing are complete.',
            inputSchema: z.object({}),
            execute: async () => ({ done: true }),
          }),
        }

        const orchestratorPrompt = await loadSimplePrompt(
          'simple-orchestrator.md',
        ).catch(() => '')
        send({
          status: isEditFlow && !payload.skip_planner ? 'planning' : 'generating',
        })
        const orchestrator = createAssistOrchestratorAgent({
          endpoint: agentEndpoint,
          instructions: [
            orchestratorPrompt ||
              'You are the SimpleAssist dispatcher. Call the available tools in order and never write the answer yourself.',
            `Current mode: ${isEditFlow ? 'edit' : 'chat'}.`,
            isEditFlow && !payload.skip_planner
              ? 'Call plan_edit before write_edit.'
              : 'Planning is disabled; go straight to drafting.',
            'Call post_process after drafting, then finish.',
          ].join('\n\n'),
          tools: orchestratorTools,
        })

        try {
          const orchestration = await orchestrator.stream({
            messages: [
              {
                role: 'user',
                content: [
                  `Mode: ${isEditFlow ? 'edit' : 'chat'}`,
                  `Instruction: ${requestMessage}`,
                  payload.selected_text
                    ? 'A text selection is active.'
                    : 'No text selection is active.',
                  `Planner: ${payload.skip_planner ? 'disabled' : 'enabled'}`,
                  `Post-processing passes: ${enabledPostProcessPasses(postConfig).length}`,
                ].join('\n'),
              },
            ],
            abortSignal: signal,
          })
          for await (const part of orchestration.fullStream) {
            if (signal.aborted) break
            if (part.type === 'reasoning-delta') {
              send({ status: 'thinking_chunk', chunk: part.text })
            }
          }
        } catch (error) {
          if (signal.aborted) throw error
          console.warn(
            `Assist orchestrator failed; using the deterministic sequence: ${errMsg(error)}`,
          )
        }

        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

        // Guarantee the user-visible outcome even if the orchestrator model
        // skipped a step (small local models often do).
        if (isEditFlow) {
          if (!editRun) await runEdit()
        } else if (!chatRun) {
          await runChat()
        }
        if (!finalized) await runPostProcess()
        c.close()
      } catch (e) {
        if (!signal.aborted && claimedWriteClarification) {
          restorePendingWriteClarification(claimedWriteClarification)
        }
        if (signal.aborted) {
          try {
            send({ status: 'error', detail: 'Stopped' })
          } catch {
            // stream already gone
          }
          c.close()
          return
        }
        try {
          // Tolerant re-resolution: the original `ws` may not exist if a
          // failure happened before it was resolved.
          const ws = await requestWorkspaceDir(request).catch(() => undefined)
          await saveSimpleAiLog({
            mode: payload.mode,
            session_id: payload.session_id,
            system_prompt: systemPrompt,
            user_prompt: userPrompt || payload.message,
            output: `Error: ${errMsg(e)}`,
            instruction: payload.message,
            selected_text: payload.selected_text,
            ref_files: null,
            success: false,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          }, ws)
        } catch {
          // logging must not break the stream
        }
        send({ status: 'error', detail: errMsg(e) })
        c.close()
      } finally {
        if (payload.session_id) releaseController(payload.session_id)
      }
      })().catch((error: unknown) => {
        // The workflow handles expected failures itself; this protects the
        // stream from an unexpected failure in its cleanup path.
        try {
          c.error(error)
        } catch {
          // The client may already have cancelled the response.
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
