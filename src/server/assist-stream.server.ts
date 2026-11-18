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
  formatCacheInfo,
  loadSimplePrompt,
  parsePlannerOutput,
  pickWriterMaxTokens,
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
  getHarnessSession,
  getWorkspaceAiLogs,
  registerController,
  releaseController,
  saveSimpleAiLog,
  setHarnessSession,
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
  type AssistAgentTelemetry,
} from './assist-agents.server'
import { splitThinkingTags, ThinkingTagFilter } from './thinking-filter.server'
import { tool, type ModelMessage, type ToolSet } from 'ai'
import { z } from 'zod'
import { recallMemoryContext } from './memory.server'
import { createMemoryEmbedder, memoryConfig, openMemoryStore, saveMemoryText } from './memory.server'
import { extractMemoryCandidates } from './memory-extraction.server'
import { join } from 'node:path'
import { DATA_ROOT } from './env.server'

export function runSimpleAssist(payload: SimpleAssistRequest, request: Request): Response {
  const ctrl = payload.session_id ? registerController(payload.session_id) : new AbortController()
  const signal = ctrl.signal

  const stream = new ReadableStream({
    async start(c) {
      const send = (obj: unknown) => c.enqueue(new TextEncoder().encode(sse(obj)))
      let systemPrompt = ''
      let userPrompt = ''
      const editMode = payload.selected_text ? 'replace' : 'insert'
      try {
        const settings = await requestSettings(request)
        const ws = await requestWorkspaceDir(request)
        const characterMessage = await readCharacterState(ws)
          .then(formatCharacterPrompt)
          .catch((error) => {
            console.warn(`Character context unavailable: ${errMsg(error)}`)
            return null
          })
        const mode = payload.mode.trim().toLowerCase()
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
          ].join('\n'),
          availableFiles: payload.available_files,
          readFile,
          ignoredRefFiles: (settings as { ignored_ref_files?: string[] }).ignored_ref_files,
        })
        const maxToks = pickWriterMaxTokens(settings as never)
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
          const agent = createAssistPostProcessAgent({
            endpoint: {
              model: input.client.model,
              baseUrl: input.client.baseUrl,
              apiKey: input.client.apiKey,
            },
            instructions: input.system,
            temperature: input.temperature,
            maxOutputTokens: input.maxTokens,
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
          defaultMaxTokens: maxToks,
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
            const req = { ...payload, message: payload.message }
            const deps = {
              settings: settings as never,
              chatPrompt: await loadSimplePrompt('simple-chat.md').catch(() => ''),
              readFile: (p: string) => readWorkspaceFile(p, ws).catch(() => null),
              message: payload.message,
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
            message: payload.message,
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
            plan: parsePlannerOutput(planRaw, payload.message),
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
          const query = plan?.plan.refined_query || payload.message
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
            maxOutputTokens: maxToks,
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
           const composed = await composeChatMessages(payload as never, {
             settings: settings as never,
            chatPrompt,
            readFile,
            message: payload.message,
            logs: chatLogs as never,
             expandedTagged: tagged,
           })
           let memoryContext = ''
           try {
             memoryContext = await recallMemoryContext(ws, payload.message)
           } catch (error) {
             console.warn(`Memory recall unavailable: ${errMsg(error)}`)
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
            maxOutputTokens: maxToks,
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
          const extractionConfig = memoryConfig()
          if (extractionConfig.extractionEnabled && extractionConfig.embeddingUrl && extractionConfig.embeddingModel) {
            void (async () => {
              try {
                const candidates = await extractMemoryCandidates({
                  userMessage: payload.message,
                  assistantMessage: finalChat,
                  settings: settings as never,
                })
                if (candidates.length === 0) return
                const memoryStore = await openMemoryStore(
                  extractionConfig.databasePath ?? join(DATA_ROOT, 'memory.duckdb'),
                )
                try {
                  for (const candidate of candidates) {
                    await saveMemoryText(memoryStore, createMemoryEmbedder(extractionConfig), {
                      workspaceKey: ws,
                      sessionId: payload.session_id ?? null,
                      kind: candidate.kind,
                      content: candidate.content,
                      sourceMessage: payload.message,
                    })
                  }
                } finally {
                  await memoryStore.close()
                }
              } catch (error) {
                console.warn(`Memory extraction unavailable: ${errMsg(error)}`)
              }
            })()
          }
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
                  `Instruction: ${payload.message}`,
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
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
