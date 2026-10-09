import {
  buildGeneratorPrompts,
  buildHarnessChatPrompt,
  buildHarnessEditPrompt,
  cacheOptsForSession,
  collectManifestSections,
  composeChatMessages,
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
import { LLMClient, loadLlmConfig } from './llm.server'
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

interface PromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Assemble the outgoing message array: frozen system head, append-only
 * history, the standalone referenced-files message (filename-explicit
 * sections, omitted when null), then the volatile user message.
 * `fullUser` joins files + user for ai_logs / prefix-hash continuity.
 */
function assembleMessages(
  system: string,
  history: PromptMessage[],
  files: string | null,
  user: string,
): { messages: PromptMessage[]; fullUser: string } {
  const messages: PromptMessage[] = [{ role: 'system', content: system }]
  messages.push(...history)
  if (files) messages.push({ role: 'user', content: files })
  messages.push({ role: 'user', content: user })
  return { messages, fullUser: files ? `${files}\n\n${user}` : user }
}

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
        const mode = payload.mode.trim().toLowerCase()
        const harness = payload.harness && payload.harness !== 'api' ? payload.harness : null

        if (harness && harness !== 'none') {
          send({ status: 'generating' })
          let activePath: string | null = null
          if (payload.active_filename) {
            activePath =
              payload.available_files.find((f) => f.name === payload.active_filename)?.path ?? null
            if (activePath && payload.content) {
              try {
                await writeWorkspaceFile(activePath, payload.content, ws)
              } catch (e) {
                console.warn(`Harness pre-flush failed for ${activePath}: ${errMsg(e)}`)
              }
            }
          }
          const tagged = taggedPaths(payload)
          let harnessPrompt = ''
          if (mode === 'edit') {
            send({ status: 'context_resolved', context_needed: [] })
            const idx = await workspaceIndexLine(ws).catch(() => '')
            const built = buildHarnessEditPrompt({
              activePath,
              selectedText: payload.selected_text,
              cursorParagraphText: payload.cursor_paragraph_text,
              taggedFiles: tagged,
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
            }
            const composed = await composeChatMessages(req as never, deps as never)
            const idx = await workspaceIndexLine(ws).catch(() => '')
            const built = buildHarnessChatPrompt({
              system: composed.system,
              userMessage: composed.files ? `${composed.files}\n\n${composed.user}` : composed.user,
              indexLine: idx || undefined,
            })
            systemPrompt = built.system
            userPrompt = composed.user
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
            mode,
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
          await saveSimpleAiLog({
            mode: mode === 'chat' ? 'chat' : 'edit_write',
            session_id: payload.session_id,
            system_prompt: isServiceTransport(harness)
              ? systemPrompt
              : resolveHarnessArgv(harness, harnessPrompt, ws, mode, resumeId, overrides)
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
          }, ws)
          send({ status: 'harness_done', harness })
          c.close()
          return
        }

        const client = loadLlmConfig(settings as never)
        const maxToks = pickWriterMaxTokens(settings as never)
        const readFile = (p: string) => readWorkspaceFile(p, ws).catch(() => null)

        if (mode === 'edit') {
          if (!payload.skip_planner) {
            send({ status: 'planning' })
            const tagged = taggedPaths(payload)
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
            userPrompt = planner.user
            const plannerCache = cacheOptsForSession(settings as never, payload.session_id, systemPrompt)
            console.log(formatCacheInfo('planner', systemPrompt, userPrompt, { slotId: plannerCache.slotId }))
            const planRaw = await client.generateBlocking(systemPrompt, userPrompt, {
              temperature: 0.3,
              maxTokens: 800,
              signal,
              cachePrompt: plannerCache.cachePrompt,
              nKeep: plannerCache.nKeep,
              slotId: plannerCache.slotId,
            })
            console.log(
              formatCacheInfo('planner', systemPrompt, userPrompt, {
                slotId: plannerCache.slotId,
                promptMs: client.lastTimings?.prompt_ms as number | undefined,
                promptN: client.lastTimings?.prompt_n as number | undefined,
                tokensCached: client.lastTokensCached,
              }),
            )
            const plannerPromptMs = (client.lastTimings?.prompt_ms as number | undefined) ?? null
            void plannerPromptMs
            const plannerTokensCached = client.lastTokensCached
            void plannerTokensCached
            const plan = parsePlannerOutput(planRaw, payload.message)
            const contextNeeded: string[] = [...(plan.context_needed ?? [])]
            const query: string = plan.refined_query || payload.message
            for (const p of tagged) if (!contextNeeded.includes(p)) contextNeeded.push(p)
            send({ status: 'context_resolved', context_needed: contextNeeded })
            send({ status: 'generating' })
            const anchor = extractAnchorContext(payload.content, payload.selected_text, payload.cursor_paragraph_text)
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
            const writerMsgs = assembleMessages(systemPrompt, [], gen.files, gen.user)
            userPrompt = writerMsgs.fullUser
            const writerCache = cacheOptsForSession(settings as never, payload.session_id, systemPrompt)
            console.log(formatCacheInfo('writer', systemPrompt, userPrompt, { slotId: writerCache.slotId }))
            let fullRaw = ''
            for await (const chunk of client.streamWithMessages(writerMsgs.messages, { temperature: 0.7, maxTokens: maxToks ?? undefined, signal, cachePrompt: writerCache.cachePrompt, nKeep: writerCache.nKeep, slotId: writerCache.slotId })) {
              if (signal.aborted) break
              fullRaw += chunk
              send({ status: 'chunk', chunk })
            }
            console.log(
              formatCacheInfo('writer', systemPrompt, userPrompt, {
                slotId: writerCache.slotId,
                promptMs: client.lastTimings?.prompt_ms,
                promptN: client.lastTimings?.prompt_n,
                tokensCached: client.lastTokensCached,
              }),
            )
            let clean = fullRaw.trim()
            if (clean.startsWith('```')) {
              const lines = clean.split('\n')
              if (lines[0]?.startsWith('```')) lines.shift()
              if (lines.length && lines[lines.length - 1]?.startsWith('```')) lines.pop()
              clean = lines.join('\n').trim()
            }
            const usage = client.lastUsage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            await saveSimpleAiLog({
              mode: 'edit_write',
              session_id: payload.session_id,
              system_prompt: systemPrompt,
              user_prompt: userPrompt,
              output: fullRaw,
              instruction: payload.message,
              selected_text: payload.selected_text,
              ref_files: null,
              success: true,
              prompt_tokens: usage.prompt_tokens ?? 0,
              completion_tokens: usage.completion_tokens ?? 0,
              total_tokens: usage.total_tokens ?? 0,
              thinking_output: client.lastThinking,
              edit_mode: editMode,
              planner_system_prompt: planner.system,
              planner_user_prompt: planner.user,
              planner_output: planRaw,
              cursor_paragraph_index: anchor.targetIdx ?? null,
              model_used: client.lastModelUsed,
              system_hash: prefixHash(systemPrompt),
              user_hash: prefixHash(userPrompt),
              prompt_ms: (client.lastTimings?.prompt_ms as number | undefined) ?? null,
              tokens_cached: client.lastTokensCached,
              slot_id: writerCache.slotId ?? null,
            }, ws)
            send({ status: 'applied', output: clean, cursor_paragraph_index: anchor.targetIdx ?? null, model_used: client.lastModelUsed })
          } else {
            const tagged = taggedPaths(payload)
            send({ status: 'context_resolved', context_needed: tagged })
            send({ status: 'generating' })
            const anchor = extractAnchorContext(payload.content, payload.selected_text, payload.cursor_paragraph_text)
            const writerPrompt = await loadSimplePrompt('simple-writer.md').catch(() => '')
            const gen = await buildGeneratorPrompts({
              paragraphBefore: anchor.paragraphBefore,
              targetParagraph: anchor.targetParagraph,
              paragraphAfter: anchor.paragraphAfter,
              query: payload.message,
              contextNeeded: tagged,
              availableFiles: payload.available_files,
              settings: settings as never,
              writerPrompt,
              readFile,
            })
            systemPrompt = gen.system
            const writerMsgs = assembleMessages(systemPrompt, [], gen.files, gen.user)
            userPrompt = writerMsgs.fullUser
            const writerCache = cacheOptsForSession(settings as never, payload.session_id, systemPrompt)
            console.log(formatCacheInfo('writer', systemPrompt, userPrompt, { slotId: writerCache.slotId }))
            let fullRaw = ''
            for await (const chunk of client.streamWithMessages(writerMsgs.messages, { temperature: 0.7, maxTokens: maxToks ?? undefined, signal, cachePrompt: writerCache.cachePrompt, nKeep: writerCache.nKeep, slotId: writerCache.slotId })) {
              if (signal.aborted) break
              fullRaw += chunk
              send({ status: 'chunk', chunk })
            }
            console.log(
              formatCacheInfo('writer', systemPrompt, userPrompt, {
                slotId: writerCache.slotId,
                promptMs: client.lastTimings?.prompt_ms,
                promptN: client.lastTimings?.prompt_n,
                tokensCached: client.lastTokensCached,
              }),
            )
            const usage = client.lastUsage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            await saveSimpleAiLog({
              mode: 'edit_write',
              session_id: payload.session_id,
              system_prompt: systemPrompt,
              user_prompt: userPrompt,
              output: fullRaw,
              instruction: payload.message,
              selected_text: payload.selected_text,
              ref_files: null,
              success: true,
              prompt_tokens: usage.prompt_tokens ?? 0,
              completion_tokens: usage.completion_tokens ?? 0,
              total_tokens: usage.total_tokens ?? 0,
              thinking_output: client.lastThinking,
              edit_mode: editMode,
              cursor_paragraph_index: anchor.targetIdx ?? null,
              model_used: client.lastModelUsed,
              system_hash: prefixHash(systemPrompt),
              user_hash: prefixHash(userPrompt),
              prompt_ms: (client.lastTimings?.prompt_ms as number | undefined) ?? null,
              tokens_cached: client.lastTokensCached,
              slot_id: writerCache.slotId ?? null,
            }, ws)
            const clean = fullRaw.trim()
            send({ status: 'applied', output: clean, cursor_paragraph_index: anchor.targetIdx ?? null, model_used: client.lastModelUsed })
          }
        } else {
          send({ status: 'generating' })
          const chatPrompt = await loadSimplePrompt('simple-chat.md').catch(() => '')
          const chatLogs = await getWorkspaceAiLogs(ws, payload.session_id).catch(() => [])
          const composed = await composeChatMessages(payload as never, {
            settings: settings as never,
            chatPrompt,
            readFile,
            message: payload.message,
            logs: chatLogs as never,
          })
          systemPrompt = composed.system
          const chatMsgs = assembleMessages(systemPrompt, composed.history, composed.files, composed.user)
          userPrompt = chatMsgs.fullUser
          const chatCache = cacheOptsForSession(settings as never, payload.session_id, systemPrompt)
          console.log(formatCacheInfo('chat', systemPrompt, userPrompt, { slotId: chatCache.slotId }))
          const llm = client as LLMClient
          let fullChat = ''
          for await (const chunk of llm.streamWithMessages(
            chatMsgs.messages,
            { temperature: 0.7, maxTokens: maxToks ?? undefined, signal, cachePrompt: chatCache.cachePrompt, nKeep: chatCache.nKeep, slotId: chatCache.slotId },
          )) {
            if (signal.aborted) break
            fullChat += chunk
            send({ status: 'chunk', chunk })
          }
          console.log(
            formatCacheInfo('chat', systemPrompt, userPrompt, {
              slotId: chatCache.slotId,
              promptMs: llm.lastTimings?.prompt_ms,
              promptN: llm.lastTimings?.prompt_n,
              tokensCached: llm.lastTokensCached,
            }),
          )
          const usage = llm.lastUsage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          await saveSimpleAiLog({
            mode: 'chat',
            session_id: payload.session_id,
            system_prompt: systemPrompt,
            user_prompt: userPrompt,
            output: fullChat,
            instruction: payload.message,
            selected_text: payload.selected_text,
            ref_files: null,
            success: true,
            prompt_tokens: usage.prompt_tokens ?? 0,
            completion_tokens: usage.completion_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0,
            thinking_output: llm.lastThinking,
            model_used: llm.lastModelUsed,
            system_hash: prefixHash(systemPrompt),
            user_hash: prefixHash(userPrompt),
            prompt_ms: (llm.lastTimings?.prompt_ms as number | undefined) ?? null,
            tokens_cached: llm.lastTokensCached,
            slot_id: chatCache.slotId ?? null,
          }, ws)
          send({ status: 'chat', output: fullChat, model_used: llm.lastModelUsed })
        }
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

