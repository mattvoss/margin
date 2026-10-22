/**
 * Post-processing pipeline — server side.
 *
 * Ports the core idea of closuretxt/recast-post-processing (AGPL-3.0): after a
 * generation, run an ordered list of independent passes. Each pass gets only
 * the previous pass's text plus optional context; it never sees the original
 * instruction or prompt. Failures are non-fatal and keep the previous text.
 *
 * Endpoint Edit/Chat call `runPostProcessPipeline`. Harness runs call
 * `runHarnessPostProcess`, which post-processes only the paragraph hunks the
 * harness changed in the active file, then writes the result back so the
 * existing three-way merge/review still applies.
 */

import {
  enabledPostProcessPasses,
  normalizePostProcessing,
  postProcessingForMode,
  MAX_HARNESS_CHARS,
  MAX_HARNESS_HUNKS,
  type PostProcessPass,
  type PostProcessingSettings,
} from '../lib/postProcessing'
import { changedHunks, splitParas, type TextHunk } from '../lib/textDiff'
import {
  injectPinnedRefFiles,
  type AnchorContext,
  type AssistFileReader,
  type AssistSettings,
} from './assist.server'
import { loadLlmConfig, type ChatMessage } from './llm.server'
import { getWorkspaceAiLogs, type AiLogEntry } from './sessions.server'

export type PostProcessMode = 'edit' | 'chat' | 'harness'
export type PostProcessPassStatus = 'ok' | 'empty' | 'failed' | 'skipped'

export interface PostProcessPassResult {
  id: string
  name: string
  /** 1-based harness hunk number; absent for endpoint runs. */
  hunk?: number
  endpoint_id: string | null
  model: string | null
  status: PostProcessPassStatus
  error?: string
  input_chars: number
  output_chars: number
  prompt_tokens: number
  completion_tokens: number
  thinking?: string | null
}

export type PostProcessEvent =
  | { type: 'start'; source: PostProcessMode; total: number }
  | {
      type: 'pass_start'
      source: PostProcessMode
      index: number
      total: number
      id: string
      name: string
    }
  | {
      type: 'pass_done'
      source: PostProcessMode
      index: number
      total: number
      id: string
      name: string
      status: PostProcessPassStatus
      error?: string
    }
  | { type: 'skipped'; source: PostProcessMode; reason: string }

export interface PostProcessContext {
  settings: AssistSettings
  workspaceDir: string
  sessionId: string | null
  characterMessage: string | null
  availableFiles: Array<{ name: string; path: string }>
  readFile: AssistFileReader
  anchor?: AnchorContext | null
  /** Pre-fetched session logs; loaded on demand when omitted. */
  logs?: AiLogEntry[] | null
  /** Writer max tokens used when a pass does not override it. */
  defaultMaxTokens?: number | null
  signal?: AbortSignal
  onEvent?: (event: PostProcessEvent) => void
}

export interface PostProcessResult {
  text: string
  original: string
  skipped: boolean
  reason?: string
  /** Text snapshots for inspection: endpoint runs start with the original
   *  output; harness runs collect snapshots per processed hunk. */
  snapshots: string[]
  passes: PostProcessPassResult[]
}

export interface RunPostProcessInput extends PostProcessContext {
  text: string
  mode: PostProcessMode
}

export interface HarnessPostProcessInput extends PostProcessContext {
  before: string
  after: string
  filePath: string
}

export interface HarnessPostProcessResult extends PostProcessResult {
  hunks: number
  skippedHunks: number
}

const MAX_CONTEXT_CHARS = 12_000
const MAX_SCENE_ENTRY_CHARS = 2_000

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}\n…[truncated]`
}

/** Strip a wrapping markdown code fence, matching the Writer's cleanup. */
export function stripCodeFences(text: string): string {
  const clean = text.trim()
  if (!clean.startsWith('```')) return clean
  const lines = clean.split('\n')
  if (lines[0]?.startsWith('```')) lines.shift()
  if (lines.length > 0 && lines[lines.length - 1]?.trim() === '```') lines.pop()
  return lines.join('\n').trim()
}

function formatSceneContext(logs: AiLogEntry[], limit: number): string | null {
  if (limit <= 0) return null
  const usable = logs
    .filter((log) => log.success !== false && (log.instruction || log.output))
    .slice(-limit)
  if (usable.length === 0) return null
  const lines: string[] = []
  for (const log of usable) {
    if (log.instruction) lines.push(`USER: ${truncate(log.instruction, MAX_SCENE_ENTRY_CHARS)}`)
    if (log.output) lines.push(`ASSISTANT: ${truncate(log.output, MAX_SCENE_ENTRY_CHARS)}`)
  }
  return lines.join('\n\n')
}

function buildDocumentBlock(anchor?: AnchorContext | null): string | null {
  if (!anchor) return null
  const before = anchor.paragraphBefore?.trim() ?? ''
  const target = anchor.targetParagraph?.trim() ?? ''
  const after = anchor.paragraphAfter?.trim() ?? ''
  if (!before && !target && !after) return null
  const lines: string[] = []
  if (before) lines.push(`BEFORE:\n${before}`)
  if (target) lines.push(`TARGET:\n${target}`)
  if (after) lines.push(`AFTER:\n${after}`)
  return `<document_context>\n${truncate(lines.join('\n\n'), MAX_CONTEXT_CHARS)}\n</document_context>`
}

async function buildPinnedRefsBlock(
  pass: PostProcessPass,
  ctx: PostProcessContext,
): Promise<string | null> {
  if (!pass.include_pinned_refs) return null
  const parts: string[] = []
  try {
    await injectPinnedRefFiles(
      parts,
      new Set(),
      ctx.settings,
      ctx.availableFiles,
      ctx.readFile,
    )
  } catch {
    return null
  }
  if (parts.length === 0) return null
  return `<reference_files>\n${truncate(parts.join('\n\n'), MAX_CONTEXT_CHARS)}\n</reference_files>`
}

async function loadLogs(ctx: PostProcessContext): Promise<AiLogEntry[]> {
  if (ctx.logs) return ctx.logs
  try {
    return await getWorkspaceAiLogs(ctx.workspaceDir, ctx.sessionId)
  } catch {
    return []
  }
}

/** Build the two-message request for one pass. Exported for tests. */
export async function buildPassMessages(
  pass: PostProcessPass,
  text: string,
  ctx: PostProcessContext,
): Promise<{ system: string; user: string; messages: ChatMessage[] }> {
  const system = pass.prompt.trim()
  const parts: string[] = []

  if (pass.include_character && ctx.characterMessage?.trim()) {
    parts.push(
      `<characters>\n${truncate(ctx.characterMessage, MAX_CONTEXT_CHARS)}\n</characters>`,
    )
  }

  if (pass.include_scene && pass.context_length > 0) {
    const scene = formatSceneContext(await loadLogs(ctx), pass.context_length)
    if (scene) parts.push(`<scene_context>\n${truncate(scene, MAX_CONTEXT_CHARS)}\n</scene_context>`)
  }

  const refs = await buildPinnedRefsBlock(pass, ctx)
  if (refs) parts.push(refs)

  if (pass.include_document) {
    const doc = buildDocumentBlock(ctx.anchor)
    if (doc) parts.push(doc)
  }

  parts.push(`<text_to_transform>\n${text}\n</text_to_transform>`)

  const user = parts.join('\n\n')
  return {
    system,
    user,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }
}

function skippedResult(
  original: string,
  reason: string,
  source: PostProcessMode,
  onEvent?: (event: PostProcessEvent) => void,
): PostProcessResult {
  onEvent?.({ type: 'skipped', source, reason })
  return {
    text: original,
    original,
    skipped: true,
    reason,
    snapshots: [original],
    passes: [],
  }
}

/**
 * Run the enabled passes in order. A pass receives only the previous pass's
 * output. Failed/empty passes keep the previous text and are reported.
 */
export async function runPostProcessPipeline(
  input: RunPostProcessInput,
): Promise<PostProcessResult> {
  const original = input.text
  const source = input.mode
  const config: PostProcessingSettings = normalizePostProcessing(
    input.settings.post_processing,
  )

  if (!postProcessingForMode(config, source)) {
    return skippedResult(original, 'disabled', source, input.onEvent)
  }
  const passes = enabledPostProcessPasses(config)
  if (passes.length === 0) {
    return skippedResult(original, 'no_passes', source, input.onEvent)
  }
  if (original.trim().length < config.min_chars) {
    return skippedResult(original, 'min_chars', source, input.onEvent)
  }
  if (input.signal?.aborted) {
    return skippedResult(original, 'aborted', source, input.onEvent)
  }

  input.onEvent?.({ type: 'start', source, total: passes.length })

  let text = original
  const snapshots = [original]
  const results: PostProcessPassResult[] = []
  let logs = input.logs
  if (logs == null && passes.some((p) => p.include_scene && p.context_length > 0)) {
    logs = await loadLogs(input)
  }
  const passContext = logs == null ? input : { ...input, logs }

  for (let index = 0; index < passes.length; index++) {
    const pass = passes[index]
    if (input.signal?.aborted) {
      results.push({
        id: pass.id,
        name: pass.name,
        endpoint_id: pass.endpoint_id,
        model: null,
        status: 'skipped',
        error: 'aborted',
        input_chars: text.length,
        output_chars: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
      })
      break
    }

    input.onEvent?.({
      type: 'pass_start',
      source,
      index,
      total: passes.length,
      id: pass.id,
      name: pass.name,
    })

    let client: ReturnType<typeof loadLlmConfig> | null = null
    try {
      const built = await buildPassMessages(pass, text, passContext)
      client = loadLlmConfig(input.settings as never, pass.endpoint_id)
      const raw = await client.generateBlockingWithMessages(built.messages, {
        temperature: pass.temperature,
        maxTokens: pass.max_tokens ?? input.defaultMaxTokens ?? undefined,
        signal: input.signal,
      })
      const output = stripCodeFences(raw)
      const status: PostProcessPassStatus = output ? 'ok' : 'empty'
      const usage = client.lastUsage
      results.push({
        id: pass.id,
        name: pass.name,
        endpoint_id: pass.endpoint_id,
        model: client.lastModelUsed || null,
        status,
        input_chars: text.length,
        output_chars: output.length,
        prompt_tokens: usage?.prompt_tokens ?? 0,
        completion_tokens: usage?.completion_tokens ?? 0,
        thinking: client.lastThinking,
      })
      if (output) {
        text = output
        snapshots.push(text)
      }
    } catch (error) {
      const usage = client?.lastUsage
      results.push({
        id: pass.id,
        name: pass.name,
        endpoint_id: pass.endpoint_id,
        model: client?.lastModelUsed || null,
        status: input.signal?.aborted ? 'skipped' : 'failed',
        error: input.signal?.aborted ? 'aborted' : errMsg(error),
        input_chars: text.length,
        output_chars: 0,
        prompt_tokens: usage?.prompt_tokens ?? 0,
        completion_tokens: usage?.completion_tokens ?? 0,
        thinking: client?.lastThinking ?? null,
      })
      if (input.signal?.aborted) break
    }

    input.onEvent?.({
      type: 'pass_done',
      source,
      index,
      total: passes.length,
      id: pass.id,
      name: pass.name,
      status: results[results.length - 1]?.status ?? 'failed',
      error: results[results.length - 1]?.error,
    })
  }

  return {
    text,
    original,
    skipped: false,
    snapshots,
    passes: results,
  }
}

/**
 * Post-process only the paragraph hunks a harness changed in the active file.
 * Processing runs in document order with an index offset so replacements do
 * not invalidate later hunk positions.
 */
export async function runHarnessPostProcess(
  input: HarnessPostProcessInput,
): Promise<HarnessPostProcessResult> {
  const source: PostProcessMode = 'harness'
  const config = normalizePostProcessing(input.settings.post_processing)
  const empty: HarnessPostProcessResult = {
    text: input.after,
    original: input.after,
    skipped: true,
    snapshots: [],
    passes: [],
    hunks: 0,
    skippedHunks: 0,
  }

  if (!postProcessingForMode(config, 'harness')) {
    return { ...empty, reason: 'disabled' }
  }
  const passes = enabledPostProcessPasses(config)
  if (passes.length === 0) return { ...empty, reason: 'no_passes' }

  const hunks = changedHunks(input.before, input.after)
  if (hunks.length === 0) return { ...empty, reason: 'no_changes' }

  const paragraphs = splitParas(input.after)
  const selected: Array<{ hunk: TextHunk; text: string }> = []
  let totalChars = 0
  let tooShort = 0
  for (const hunk of hunks) {
    if (selected.length >= MAX_HARNESS_HUNKS) break
    const hunkText = paragraphs.slice(hunk.newStart, hunk.newEnd).join('\n\n')
    if (hunkText.trim().length < config.min_chars) {
      tooShort++
      continue
    }
    if (totalChars + hunkText.length > MAX_HARNESS_CHARS) break
    selected.push({ hunk, text: hunkText })
    totalChars += hunkText.length
  }
  if (selected.length === 0) {
    return { ...empty, reason: tooShort === hunks.length ? 'min_chars' : 'too_large' }
  }
  if (input.signal?.aborted) return { ...empty, reason: 'aborted' }

  let logs = input.logs
  if (logs == null && passes.some((p) => p.include_scene && p.context_length > 0)) {
    logs = await loadLogs(input)
  }

  const totalPasses = selected.length * passes.length
  input.onEvent?.({ type: 'start', source, total: totalPasses })

  let offset = 0
  let globalPassIndex = 0
  let skippedHunks = hunks.length - selected.length
  let processedHunks = 0
  const passResults: PostProcessPassResult[] = []
  const snapshots: string[] = []

  for (let hunkIndex = 0; hunkIndex < selected.length; hunkIndex++) {
    const { hunk, text: hunkText } = selected[hunkIndex]
    const start = hunk.newStart + offset
    const end = hunk.newEnd + offset
    const result = await runPostProcessPipeline({
      ...input,
      logs,
      text: hunkText,
      mode: 'harness',
      anchor: {
        paragraphBefore: paragraphs[start - 1] ?? '',
        targetParagraph: hunkText,
        paragraphAfter: paragraphs[end] ?? '',
        targetIdx: start,
        replace: true,
      },
      onEvent: (event) => {
        if (event.type === 'pass_start') {
          input.onEvent?.({ ...event, index: globalPassIndex, total: totalPasses })
        } else if (event.type === 'pass_done') {
          input.onEvent?.({ ...event, index: globalPassIndex, total: totalPasses })
          globalPassIndex++
        } else if (event.type === 'skipped' && event.reason === 'aborted') {
          input.onEvent?.(event)
        }
      },
    })

    if (result.skipped) {
      skippedHunks++
      if (result.reason === 'aborted') break
      continue
    }

    const replacement = splitParas(result.text)
    paragraphs.splice(start, end - start, ...replacement)
    offset += replacement.length - (end - start)
    processedHunks++
    for (const pass of result.passes) {
      passResults.push({ ...pass, hunk: hunkIndex + 1 })
    }
    snapshots.push(...result.snapshots)
  }

  return {
    text: processedHunks > 0 ? paragraphs.join('\n\n') : input.after,
    original: input.after,
    skipped: processedHunks === 0,
    reason: processedHunks === 0 ? 'skipped' : undefined,
    snapshots,
    passes: passResults,
    hunks: processedHunks,
    skippedHunks,
  }
}
