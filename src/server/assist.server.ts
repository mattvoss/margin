/**
 * assist.server.ts — pure assist prompt/context pipeline for TanStack Start.
 *
 * Ports the prompt-assembly half of the Python assist backend WITHOUT the
 * SSE endpoint itself and WITHOUT any LLM network calls (those stay in the
 * route layer via llm.server). Every export is a pure function: filesystem
 * roots, settings and document content arrive as arguments, there are no
 * module globals. Only `node:fs/promises` + `node:path` (+ the local
 * DATA_ROOT constant) are imported.
 *
 * Python → TS source map:
 * - resolveSimpleAssistClientConfig ..... api/routers/assist.py:451-478
 *   (_resolve_simple_assist_client; returns a plain config object instead of
 *   an LLMClient — local thin mirror so this module never depends on the
 *   future llm.server, avoiding a circular dependency)
 * - isBlocked ........................... assist.py:481-489
 * - taggedPaths ......................... assist.py:492-503
 * - workspaceIndexLine .................. assist.py:506-528
 * - injectPinnedRefFiles ................ assist.py:531-553
 * - pickWriterMaxTokens ................. assist.py:556-563 (+ DISABLE_TOKEN_LIMITS, config.py:23)
 * - SimpleAssistRequest ................. assist.py:566-578 (Pydantic model)
 * - getSimpleLogs/deleteSessionLogs ..... assist.py:581-589 (endpoints) +
 *   file_storage.py:797-832 (get_simple_ai_logs/save_simple_ai_log)
 * - buildSimpleAssistLogEntry ........... assist.py:601-659 (_log_simple_assist field assembly)
 * - appendSimpleAssistLog ............... file_storage.py:811-832 (per-session JSON file, capped at 100)
 * - getActiveContextWindow .............. assist.py:663-673
 * - buildChatMessages ................... assist.py:676-721
 * - buildPlannerHistory ................. assist.py:724-768
 * - runPlannerPrompt/parsePlannerOutput . assist.py:772-845 (build-only; the
 *   generate_to_completion call stays in the route layer)
 * - resolveContextPath .................. assist.py:866-878 (fuzzy path fallback inside build_generator_prompts)
 * - buildGeneratorPrompts ............... assist.py:850-896
 * - composeChatPrompts .................. assist.py:937-981
 * - buildHarnessEditPrompt .............. assist.py:1030-1058 (harness edit branch prompt assembly)
 * - buildHarnessChatPrompt .............. assist.py:1060-1073 (harness chat branch prompt assembly)
 * - extractAnchorContext ................ api/services/assist_helpers.py:4-57
 * - loadSimplePrompt/resolvePromptsDir .. assist_helpers.py:60-66
 * - buildContextBlock/injectContextFile . api/services/context_injector.py:4-28
 * - THINKING_PREAMBLE ................... config.py:25-33
 */
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DATA_ROOT } from './env.server.ts'

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One endpoint entry from settings (`endpoints` map). */
export interface AssistEndpointConfig {
  url?: string
  api_key?: string
  model?: string
  context_window?: number | string
  is_thinking?: boolean
  custom_thinking_tags?: Array<{ open?: string; close?: string }>
}

/**
 * Minimal structural view of app settings used by this pipeline.
 * The index signature keeps it compatible with the full AppSettings object.
 */
export interface AssistSettings {
  active_endpoint?: string | null
  endpoints?: Record<string, AssistEndpointConfig>
  default_verbosity?: string
  default_context_window?: number | string
  history_turns?: number | string
  planner_include_outline?: boolean
  pinned_ref_files?: string[]
  ignored_ref_files?: string[]
  prepend_thinking_preamble?: boolean
  is_thinking?: boolean
  [key: string]: unknown
}

/**
 * Mirror of the `SimpleAssistRequest` Pydantic model
 * (api/routers/assist.py:566-578). Field names are kept snake_case to match
 * the Python model (and the existing POST /api/assist/simple payload) exactly.
 */
export interface SimpleAssistRequest {
  content: string
  message: string
  mode: string
  session_id: string | null
  history: Array<Record<string, unknown>>
  selected_text: string | null
  cursor_paragraph_text: string | null
  ref_files: Array<Record<string, unknown>> | null
  available_files: Array<{ path: string; name: string }>
  active_filename: string | null
  skip_planner: boolean
  harness: string | null
}

/** Apply the Pydantic field defaults to a raw parsed body. */
export function normalizeSimpleAssistRequest(input: Record<string, unknown>): SimpleAssistRequest {
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  return {
    content: typeof input.content === 'string' ? input.content : '',
    message: typeof input.message === 'string' ? input.message : '',
    mode: typeof input.mode === 'string' ? input.mode : 'chat',
    session_id: str(input.session_id) ?? null,
    history: arr(input.history),
    selected_text: str(input.selected_text) ?? null,
    cursor_paragraph_text: str(input.cursor_paragraph_text) ?? null,
    ref_files: Array.isArray(input.ref_files)
      ? (input.ref_files as Array<Record<string, unknown>>)
      : null,
    available_files: arr(input.available_files),
    active_filename: str(input.active_filename) ?? null,
    skip_planner: input.skip_planner === true,
    harness: typeof input.harness === 'string' ? input.harness : 'api',
  }
}

/** Plain-data client configuration (no fetch here — LLM calls live in llm.server). */
export interface SimpleAssistClientConfig {
  model: string | null
  baseUrl: string | null
  apiKey: string | null
  isThinking: boolean
  customOpeningTags: string[]
  customClosingTags: string[]
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface PlannerPlan {
  context_needed: string[]
  refined_query: string
}

export interface ManifestSection {
  folder: string
  path: string
  content: string
}

export interface AnchorContext {
  paragraphBefore: string
  targetParagraph: string
  paragraphAfter: string
  targetIdx: number
  replace: boolean
}

/** Reader callback supplied by the route layer (workspace file access). */
export type AssistFileReader = (path: string) => Promise<string | null>

export interface SimpleAssistLogEntry {
  id: string
  timestamp: string
  mode: string
  session_id: string | null
  system_prompt: string
  user_prompt: string
  output: string
  instruction: string
  selected_text?: string | null
  text_before?: string | null
  text_after?: string | null
  ref_files?: Array<Record<string, unknown>> | null
  success: boolean
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  thinking_output?: string | null
  tool_calls?: Array<Record<string, unknown>> | null
  edit_mode?: string | null
  planner_system_prompt?: string | null
  planner_user_prompt?: string | null
  planner_output?: string | null
  cursor_paragraph_index?: number | null
  model_used?: string | null
}

/* ------------------------------------------------------------------ */
/* Thinking preamble (config.py:25-33)                                 */
/* ------------------------------------------------------------------ */

/** Verbatim copy of `THINKING_PREAMBLE` from config.py. */
export const THINKING_PREAMBLE =
  'Before every response, you MUST think through the problem internally ' +
  'using this exact format:\n' +
  '<|channel|>thought\n' +
  '[your reasoning here]\n' +
  '<channel|>\n\n' +
  'Then provide your final answer after the closing tag.\n' +
  'This format is REQUIRED for every response, including JSON outputs.\n\n'

/**
 * Prepend THINKING_PREAMBLE when `settings.prepend_thinking_preamble` is set.
 * DEVIATION: Python defines the constant in config.py but never applies it
 * anywhere in the assist pipeline (and never reads the
 * `prepend_thinking_preamble` settings flag either — it defaults to False).
 * This helper wires the flag to the constant. The endpoint `is_thinking`
 * flag is intentionally NOT a trigger: in Python it only controls
 * reasoning-channel parsing in llm.py, never prompt text.
 */
export function applyThinkingPreamble(systemPrompt: string, settings: AssistSettings): string {
  if (settings.prepend_thinking_preamble === true) return THINKING_PREAMBLE + systemPrompt
  return systemPrompt
}

/* ------------------------------------------------------------------ */
/* Prefix-cache helpers (llama.cpp / open-weight servers)              */
/* ------------------------------------------------------------------ */

/**
 * Why this section exists: llama.cpp slot KV reuse compares the tokenized
 * prompt to the slot's previous prompt from token 0 and skips only the
 * common prefix. Any per-request mutation near the start — or
 * non-deterministic ordering / whitespace — forces a full prefill. These
 * helpers keep the stable head byte-identical and push volatile content last.
 *
 * Rules enforced by the builders below:
 * - `system` is the frozen static head only (base file + preamble state).
 * - Semi-stable context is sorted deterministically, LF-normalized.
 * - History is append-only message pairs, never rewritten into `system`.
 * - The final user message carries all volatile content, instruction last.
 */

/** LF-normalize and outer-trim. Inner content is untouched (stable). */
export function normalizePromptText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

/** Dedupe + sort alphabetically so planner/output order can't bust the prefix. */
export function sortUniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter((p) => typeof p === 'string' && p.length > 0))].sort()
}

/** Rough token estimate (len/4) for `n_keep` when no tokenizer is available. */
export function estimatePrefixTokens(text: string): number {
  if (!text) return 1
  return Math.max(1, Math.ceil(text.length / 4))
}

/** FNV-1a 32-bit hex — Step 0/7 diagnostics (system/user prefix identity). */
export function prefixHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Build the frozen static `system` head for one mode.
 *
 * Combines the loaded base prompt file with the thinking-preamble state and
 * normalizes once. Stable as long as the file content and the
 * `prepend_thinking_preamble` flag don't change mid-session — flipping the
 * flag moves byte 0 and intentionally invalidates the cached prefix.
 */
export function buildStaticSystem(basePrompt: string, settings: AssistSettings): string {
  return normalizePromptText(applyThinkingPreamble(normalizePromptText(basePrompt), settings))
}

/**
 * Cache options for one LLM call against a llama.cpp-style server.
 * - `cachePrompt` defaults true; set `settings.llama_cache_prompt === false` to disable.
 * - `nKeep` defaults to the static-system token estimate; override with numeric `settings.llama_n_keep`.
 * - `slotId` is set only when `settings.llama_pin_slots === true` (see slotIdForSession
 *   in llm.server — pinning to a nonexistent slot errors, so the default relies
 *   on the server's `-sps` similarity routing).
 */
export function cacheOptsForSession(
  settings: AssistSettings,
  sessionId: string | null | undefined,
  staticSystem: string,
): { cachePrompt: boolean; nKeep: number; slotId?: number } {
  const s = settings as Record<string, unknown>
  const cachePrompt = s['llama_cache_prompt'] !== false
  const rawKeep = s['llama_n_keep']
  const nKeep =
    typeof rawKeep === 'number' && Number.isFinite(rawKeep) ? Math.trunc(rawKeep) : estimatePrefixTokens(staticSystem)
  const out: { cachePrompt: boolean; nKeep: number; slotId?: number } = { cachePrompt, nKeep }
  if (s['llama_pin_slots'] === true && typeof sessionId === 'string' && sessionId) {
    const rawCount = s['llama_slot_count']
    const count =
      typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount > 0 ? Math.trunc(rawCount) : 4
    let h = 0x811c9dc5
    for (let i = 0; i < sessionId.length; i++) {
      h ^= sessionId.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    out.slotId = (h >>> 0) % count
  }
  return out
}

/** One-line cache diagnostic for server logs (Step 0/7 baseline + verify). */
export function formatCacheInfo(
  mode: string,
  system: string,
  user: string,
  extra?: { promptMs?: number | null; promptN?: number | null; tokensCached?: number | null; slotId?: number },
): string {
  const base =
    `[prefix-cache] mode=${mode} system_hash=${prefixHash(system)} ` +
    `system_chars=${system.length} user_hash=${prefixHash(user)} user_chars=${user.length}`
  if (!extra) return base
  const parts: string[] = []
  if (extra.slotId != null) parts.push(`slot=${extra.slotId}`)
  if (extra.promptMs != null) parts.push(`prompt_ms=${extra.promptMs}`)
  if (extra.promptN != null) parts.push(`prompt_n=${extra.promptN}`)
  if (extra.tokensCached != null) parts.push(`tokens_cached=${extra.tokensCached}`)
  return parts.length > 0 ? `${base} ${parts.join(' ')}` : base
}

/* ------------------------------------------------------------------ */
/* Prompt files (assist_helpers.py:60-66)                              */
/* ------------------------------------------------------------------ */

/**
 * Resolve the prompts directory: MARGIN_PROMPTS_DIR first, then
 * <DATA_ROOT>/prompts (Docker volume installs seed prompts there), then the
 * repo `prompts/` directory relative to the process working directory.
 * Returns the first candidate that exists as a directory.
 */
export async function resolvePromptsDir(dataRoot: string = DATA_ROOT): Promise<string> {
  const fromEnv = process.env.MARGIN_PROMPTS_DIR?.trim()
  const candidates = [
    fromEnv ? fromEnv : '',
    join(dataRoot, 'prompts'),
    resolve(process.cwd(), 'prompts'),
  ].filter((c) => c.length > 0)
  for (const dir of candidates) {
    try {
      const st = await stat(dir)
      if (st.isDirectory()) return dir
    } catch {
      /* try next candidate */
    }
  }
  return join(dataRoot, 'prompts')
}

/**
 * Load a prompt markdown file, stripped. Returns "" on any error,
 * mirroring `_load_simple_prompt`.
 */
export async function loadSimplePrompt(filename: string, promptsDir?: string): Promise<string> {
  try {
    const dir = promptsDir ?? (await resolvePromptsDir())
    return (await readFile(join(dir, filename), 'utf-8')).trim()
  } catch (e) {
    console.error(`Error loading prompt ${filename}: ${String(e)}`)
    return ''
  }
}

/* ------------------------------------------------------------------ */
/* Client config (assist.py:451-478)                                   */
/* ------------------------------------------------------------------ */

/**
 * Mirror of `_resolve_simple_assist_client`: pick the active endpoint from
 * settings and return its connection parameters. Throws (vs Python's
 * HTTPException(400)) with the same message when nothing is configured —
 * the route layer maps it to a 400.
 */
export function resolveSimpleAssistClientConfig(settings: AssistSettings): SimpleAssistClientConfig {
  const epId = settings.active_endpoint
  if (epId) {
    const ep = (settings.endpoints ?? {})[epId]
    if (ep) {
      const customTags = ep.custom_thinking_tags ?? []
      return {
        model: ep.model ?? null,
        baseUrl: ep.url ?? null,
        apiKey: ep.api_key ?? null,
        isThinking: ep.is_thinking ?? true,
        customOpeningTags: customTags
          .filter((t) => typeof t?.open === 'string')
          .map((t) => t.open as string),
        customClosingTags: customTags
          .filter((t) => typeof t?.close === 'string')
          .map((t) => t.close as string),
      }
    }
  }
  throw new Error('No endpoint configured — add one in Settings → Endpoints.')
}

/* ------------------------------------------------------------------ */
/* Blocked / tagged paths (assist.py:481-503)                         */
/* ------------------------------------------------------------------ */

/** Mirror of `_is_blocked`: directly ignored, or covered by its folder manifest. */
export function isBlocked(filepath: string, ignored?: Set<string> | string[] | null): boolean {
  const set = ignored instanceof Set ? ignored : new Set(ignored ?? [])
  const folder = filepath.split('/')[0]
  if (set.has(`${folder}/${folder.toUpperCase()}.md`)) return true
  return set.has(filepath)
}

/** Mirror of `_tagged_paths`: explicit @-tagged paths, deduped, order-preserved. */
export function taggedPaths(req: Pick<SimpleAssistRequest, 'ref_files'>): string[] {
  const seen: string[] = []
  for (const f of req.ref_files ?? []) {
    const p = (typeof f === 'object' && f !== null ? (f as Record<string, unknown>).path : null) ?? ''
    if (typeof p === 'string' && p.length > 0 && !seen.includes(p)) seen.push(p)
  }
  return seen
}

/* ------------------------------------------------------------------ */
/* Workspace manifests (assist.py:506-528, 813-824)                    */
/* ------------------------------------------------------------------ */

/** One-level `* /FOLDER.md` manifest scan, sorted by relative path. */
async function listManifestRels(workspaceDir: string): Promise<Array<{ folder: string; rel: string }>> {
  const out: Array<{ folder: string; rel: string }> = []
  let entries
  try {
    entries = await readdir(workspaceDir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const folder = entry.name
    let sub: string[]
    try {
      sub = await readdir(join(workspaceDir, folder))
    } catch {
      continue
    }
    const manifest = `${folder.toUpperCase()}.md`
    if (sub.includes(manifest)) out.push({ folder, rel: `${folder}/${manifest}` })
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

/**
 * Mirror of `_workspace_index_line`: one-line pointer to manifest indexes
 * (pointers, not contents). "" when there are none or on scan errors.
 */
export async function workspaceIndexLine(
  workspaceDir: string,
  ignored?: Set<string> | string[] | null,
): Promise<string> {
  try {
    const names: string[] = []
    for (const { rel } of await listManifestRels(workspaceDir)) {
      if (isBlocked(rel, ignored)) continue
      names.push(rel)
    }
    if (names.length === 0) return ''
    return 'Workspace indexes (read to orient yourself): ' + names.join(', ')
  } catch (e) {
    console.error(`Error scanning workspace indexes: ${String(e)}`)
    return ''
  }
}

/**
 * Collect manifest sections for the planner's AVAILABLE_CONTEXT block
 * (assist.py:813-824). Skips blocked/empty manifests.
 */
export async function collectManifestSections(
  workspaceDir: string,
  ignored?: Set<string> | string[] | null,
): Promise<ManifestSection[]> {
  const sections: ManifestSection[] = []
  try {
    for (const { folder, rel } of await listManifestRels(workspaceDir)) {
      if (isBlocked(rel, ignored)) continue
      let raw: string
      try {
        raw = await readFile(join(workspaceDir, rel), 'utf-8')
      } catch {
        continue
      }
      if (raw.trim().length === 0) continue
      sections.push({ folder, path: rel, content: raw.trim() })
    }
  } catch (e) {
    console.error(`Error scanning manifests: ${String(e)}`)
  }
  return sections
}

/* ------------------------------------------------------------------ */
/* Context injection (context_injector.py + assist.py:531-553)         */
/* ------------------------------------------------------------------ */

/**
 * File section: states the exact workspace-relative filename first, then the
 * content. Referenced files always travel in their own user-role message
 * (see joinFilesMessage), one section per file, so the model can tell files
 * apart and repeated files stay byte-identical across turns.
 * `readFile` failures leave `parts` untouched (mirrors `except: pass`).
 * NOTE: Python computes `available_paths` in the chat path and passes it to
 * `inject()`, which ignores it — the dead variable is dropped here.
 */
export function buildContextBlock(actualPath: string, content: string): string {
  return `--- FILE: ${actualPath} ---\n${content}`
}

/** Same as buildContextBlock for a pinned file (kept distinguishable). */
export function buildPinnedBlock(actualPath: string, content: string): string {
  return `--- FILE (PINNED): ${actualPath} ---\n${content}`
}

/**
 * Wrap file sections in a standalone user-message body. Null when there are
 * no sections so callers omit the message entirely. Multiple files stay
 * separated by blank lines under one stable header.
 */
export function joinFilesMessage(sections: string[]): string | null {
  if (sections.length === 0) return null
  return `REFERENCED_FILES:\n\n${sections.join('\n\n')}`
}

export async function injectContextFile(
  systemParts: string[],
  _filepath: string,
  actualPath: string,
  readFileContent: AssistFileReader,
): Promise<void> {
  try {
    const content = await readFileContent(actualPath)
    if (content === null) return
    systemParts.push(buildContextBlock(actualPath, content))
  } catch (e) {
    console.error(`Error loading context block for ${actualPath}: ${String(e)}`)
  }
}

/**
 * Mirror of `_inject_pinned_ref_files`: append pinned ref file contents with
 * filename-explicit headers, skipping already-seen / blocked / unknown paths.
 * `available` is the `{path, name}` listing (replaces storage.list_input_files()).
 */
export async function injectPinnedRefFiles(
  systemParts: string[],
  alreadySeen: Set<string>,
  settings: AssistSettings,
  available: Array<{ path: string; name: string }>,
  readFileContent: AssistFileReader,
): Promise<string[]> {
  const pinned = sortUniquePaths(settings.pinned_ref_files ?? [])
  if (pinned.length === 0) return systemParts
  const names = new Map(available.map((f) => [f.path, f.name] as const))
  const ignored = new Set(settings.ignored_ref_files ?? [])
  for (const pp of pinned) {
    if (alreadySeen.has(pp)) continue
    if (isBlocked(pp, ignored)) continue
    if (!names.has(pp)) continue
    let content: string | null
    try {
      content = await readFileContent(pp)
    } catch {
      continue
    }
    if (content === null) continue
    systemParts.push(buildPinnedBlock(pp, content))
    alreadySeen.add(pp)
  }
  return systemParts
}

/* ------------------------------------------------------------------ */
/* Token windows (assist.py:556-563, 663-673)                         */
/* ------------------------------------------------------------------ */

/**
 * Mirror of `_pick_writer_max_tokens`. `disableTokenLimits` defaults to the
 * DISABLE_TOKEN_LIMITS env var (config.py:23: "true"/"1"/"yes").
 */
export function pickWriterMaxTokens(settings: AssistSettings, disableTokenLimits?: boolean): number | null {
  const disabled =
    disableTokenLimits ?? ['true', '1', 'yes'].includes((process.env.DISABLE_TOKEN_LIMITS ?? '').toLowerCase())
  if (disabled) return null
  const mapping: Record<string, number | null> = { concise: 250, balanced: 500, expansive: 1000, none: null }
  const verbosity = settings.default_verbosity ?? 'balanced'
  if (Object.prototype.hasOwnProperty.call(mapping, verbosity)) return mapping[verbosity]
  return 500
}

/**
 * Mirror of `_get_active_context_window`. Minor leniency deviation: Python's
 * int() raises on garbage (only ValueError is caught); here unparseable
 * values fall through to the default instead of throwing.
 */
export function getActiveContextWindow(settings: AssistSettings): number {
  const epId = settings.active_endpoint
  if (epId) {
    const cw = (settings.endpoints ?? {})[epId]?.context_window
    if (cw !== undefined && cw !== null && cw !== '') {
      const n = typeof cw === 'number' ? cw : Number(cw)
      if (Number.isFinite(n)) return Math.trunc(n)
    }
  }
  const fallback = Number(settings.default_context_window ?? 8192)
  return Number.isFinite(fallback) ? Math.trunc(fallback) : 8192
}

/* ------------------------------------------------------------------ */
/* Anchor context (assist_helpers.py:4-57)                             */
/* ------------------------------------------------------------------ */

/**
 * Mirror of `extract_anchor_context`. Indices refer to the blank-filtered
 * paragraph list, exactly as in Python.
 */
export function extractAnchorContext(
  content: string,
  selectedText?: string | null,
  cursorParagraphText?: string | null,
): AnchorContext {
  const paragraphs = content.split('\n\n').filter((p) => p.trim().length > 0)
  let targetIdx = paragraphs.length - 1
  let replace = false

  if (selectedText) {
    replace = true
    let found = false
    let matchPos = -1

    for (let i = 0; i < paragraphs.length; i++) {
      const pos = paragraphs[i].indexOf(selectedText)
      if (pos !== -1) {
        targetIdx = i
        found = true
        matchPos = pos
        break
      }
    }
    if (!found) {
      for (let i = 0; i < paragraphs.length; i++) {
        const pos = paragraphs[i].indexOf(selectedText.slice(0, 50))
        if (pos !== -1) {
          targetIdx = i
          found = true
          matchPos = pos
          break
        }
      }
    }
    if (found) {
      const targetP = paragraphs[targetIdx]
      if (matchPos !== -1 && selectedText.trim() !== targetP.trim()) {
        return {
          paragraphBefore: targetP.slice(0, matchPos),
          targetParagraph: selectedText,
          paragraphAfter: targetP.slice(matchPos + selectedText.length),
          targetIdx,
          replace,
        }
      }
    }
  } else if (cursorParagraphText) {
    const cursorText = cursorParagraphText.trim()
    for (let i = 0; i < paragraphs.length; i++) {
      if (paragraphs[i].includes(cursorText.slice(0, 60))) {
        targetIdx = i
        break
      }
    }
  }

  const targetParagraph =
    paragraphs.length > 0 && targetIdx >= 0 && targetIdx < paragraphs.length ? paragraphs[targetIdx] : ''
  const paragraphBefore = targetIdx > 0 ? (paragraphs[targetIdx - 1] ?? '') : ''
  const paragraphAfter = targetIdx < paragraphs.length - 1 ? (paragraphs[targetIdx + 1] ?? '') : ''
  return { paragraphBefore, targetParagraph, paragraphAfter, targetIdx, replace }
}

/* ------------------------------------------------------------------ */
/* Chat history (assist.py:676-768)                                    */
/* ------------------------------------------------------------------ */

/** Mirror of `_build_chat_messages` (threshold_pct = 85 hardcoded, len/4 estimate). */
export function buildChatMessages(
  sessionId: string | null | undefined,
  systemPrompt: string,
  currentUserMsg: string,
  settings: AssistSettings,
  logs: SimpleAssistLogEntry[] = [],
): ChatMessage[] {
  if (!sessionId) {
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: currentUserMsg },
    ]
  }
  const filtered = logs
    .filter((log) => log.session_id === sessionId && log.mode === 'chat' && (log.success ?? true))
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))

  const historyTurns = Number(settings.history_turns ?? 5)
  const contextWindow = getActiveContextWindow(settings)
  const thresholdTokens = (85 / 100) * contextWindow

  let pairs = historyTurns > 0 ? filtered.slice(-historyTurns) : []

  for (;;) {
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]
    for (const log of pairs) {
      messages.push({ role: 'user', content: log.instruction ?? '' })
      messages.push({ role: 'assistant', content: log.output ?? '' })
    }
    messages.push({ role: 'user', content: currentUserMsg })

    if (pairs.length === 0) return messages
    const totalTokens = messages.reduce((sum, msg) => sum + msg.content.length / 4, 0)
    if (totalTokens <= thresholdTokens) return messages
    pairs = pairs.slice(1)
  }
}

/** Mirror of `_build_planner_history` over prior successful edit_plan turns. */
export function buildPlannerHistory(
  sessionId: string | null | undefined,
  settings: AssistSettings,
  logs: SimpleAssistLogEntry[] = [],
): string {
  if (!sessionId) return ''
  const filtered = logs
    .filter((log) => log.session_id === sessionId && log.mode === 'edit_plan' && (log.success ?? true))
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))

  const historyTurns = Number(settings.history_turns ?? 5)
  const recent = historyTurns > 0 ? filtered.slice(-historyTurns) : []
  if (recent.length === 0) return ''

  const lines = ['RECENT_EDITS:']
  recent.forEach((log, idx) => {
    const instruction = log.instruction ?? ''
    let refinedQuery = ''
    let contextFiles: unknown[] = []
    const plOut = log.planner_output
    if (plOut) {
      try {
        let plDict: Record<string, unknown> = {}
        if (typeof plOut === 'string') {
          try {
            plDict = JSON.parse(plOut) as Record<string, unknown>
          } catch {
            const start = plOut.indexOf('{')
            const end = plOut.lastIndexOf('}') + 1
            plDict = start !== -1 && end > start ? (JSON.parse(plOut.slice(start, end)) as Record<string, unknown>) : {}
          }
        } else if (typeof plOut === 'object') {
          plDict = plOut as Record<string, unknown>
        }
        if (Array.isArray(plDict['context_needed'])) contextFiles = plDict['context_needed'] as unknown[]
        if (typeof plDict['refined_query'] === 'string') refinedQuery = plDict['refined_query'] as string
      } catch {
        /* keep defaults */
      }
    }
    lines.push(
      `[Turn ${idx + 1}] USER: "${instruction}" → REFINED: "${refinedQuery}" → FILES: ${JSON.stringify(contextFiles)}`,
    )
  })
  return lines.join('\n')
}

/**
 * Chat history as real append-only message pairs for prefix-KV reuse.
 *
 * Unlike `buildPlannerHistory` (which squashes history into a RECENT_EDITS
 * text block inside `system` — cache-hostile), this returns
 * `[user, assistant, ...]` pairs that the caller places between the frozen
 * system head and the final volatile user message. Oldest first, capped by
 * `history_turns`, front-truncated only so the surviving prefix stays stable.
 * Empty instructions/outputs are skipped so role alternation stays clean.
 */
export function buildChatHistoryMessages(
  sessionId: string | null | undefined,
  settings: AssistSettings,
  logs: SimpleAssistLogEntry[] = [],
): ChatMessage[] {
  if (!sessionId) return []
  const historyTurns = Number(settings.history_turns ?? 5)
  if (!(historyTurns > 0)) return []
  const filtered = logs
    .filter((log) => log.session_id === sessionId && log.mode === 'chat' && (log.success ?? true))
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
  const recent = filtered.slice(-historyTurns)
  const out: ChatMessage[] = []
  for (const log of recent) {
    const instruction = (log.instruction ?? '').trim()
    const output = (log.output ?? '').trim()
    if (instruction) out.push({ role: 'user', content: instruction })
    if (output) out.push({ role: 'assistant', content: output })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Planner prompt (assist.py:772-845, build-only)                      */
/* ------------------------------------------------------------------ */

export interface PlannerPromptInput {
  content: string
  message: string
  selectedText?: string | null
  cursorParagraphText?: string | null
  sessionId?: string | null
  taggedFiles?: string[]
  settings: AssistSettings
  logs?: SimpleAssistLogEntry[]
  manifests?: ManifestSection[]
  /** Loaded simple-planner.md content. */
  plannerPrompt: string
}

/**
 * Build-only mirror of `run_planner`: assembles {system, user} without
 * calling the LLM (the route layer performs generate_to_completion).
 *
 * Prefix-cache order (stable → volatile): manifests first (workspace
 * indexes, rarely change), then RECENT_EDITS history, tagged files,
 * outline/anchor (document-derived), instruction last. `system` is the
 * frozen planner file only — see buildStaticSystem at the call site.
 */
export function runPlannerPrompt(input: PlannerPromptInput): { system: string; user: string } {
  const userLines: string[] = []

  const manifests = [...(input.manifests ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (manifests.length > 0) {
    userLines.push(
      'AVAILABLE_CONTEXT:\n' +
        manifests.map((m) => `--- ${m.folder.toUpperCase()} ---\n${m.content.trim()}`).join('\n\n') +
        '\n',
    )
  }

  const history = buildPlannerHistory(input.sessionId ?? null, input.settings, input.logs ?? [])
  if (history) userLines.push(`${history}\n`)

  const tagged = sortUniquePaths(input.taggedFiles ?? [])
  if (tagged.length > 0) {
    userLines.push(`TAGGED_FILES (user explicitly attached):\n${tagged.join('\n')}\n`)
  }

  if (input.settings.planner_include_outline === true) {
    const paragraphs = input.content.split('\n\n').filter((p) => p.trim().length > 0)
    const outline = paragraphs
      .map((p, i) => `[${i}] ${p.slice(0, 60).replace(/\n/g, ' ')}...`)
      .join('\n')
    userLines.push(`DOCUMENT_OUTLINE:\n${outline}\n`)
  }

  if (input.selectedText) {
    userLines.push(`SELECTED_TEXT:\n${input.selectedText}\n`)
  } else if (input.cursorParagraphText) {
    userLines.push(`ANCHOR_PARAGRAPH_TEXT:\n${input.cursorParagraphText}\n`)
  }

  userLines.push(`USER_INSTRUCTION:\n${input.message}\n`)

  return { system: buildStaticSystem(input.plannerPrompt, input.settings), user: userLines.join('\n') }
}

/**
 * Mirror of run_planner's JSON recovery (assist.py:838-845): strict parse,
 * then brace-extraction, then the empty-plan default.
 */
export function parsePlannerOutput(raw: string, fallbackMessage: string): PlannerPlan {
  const coerce = (v: unknown): PlannerPlan => {
    const d = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
    return {
      context_needed: Array.isArray(d['context_needed'])
        ? (d['context_needed'] as unknown[]).map(String)
        : [],
      refined_query: typeof d['refined_query'] === 'string' ? (d['refined_query'] as string) : fallbackMessage,
    }
  }
  try {
    return coerce(JSON.parse(raw) as unknown)
  } catch {
    try {
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}') + 1
      if (start !== -1 && end > start) return coerce(JSON.parse(raw.slice(start, end)) as unknown)
    } catch {
      /* fall through to default */
    }
    return { context_needed: [], refined_query: fallbackMessage }
  }
}

/* ------------------------------------------------------------------ */
/* Generator prompts (assist.py:850-896)                               */
/* ------------------------------------------------------------------ */

/** Longest-match size of one block pair (difflib-style, no autojunk). */
function longestMatchSize(
  a: string,
  b: string,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
): { i: number; j: number; size: number } {
  let bestI = aLo
  let bestJ = bLo
  let bestSize = 0
  for (let i = aLo; i < aHi; i++) {
    for (let j = bLo; j < bHi; j++) {
      let k = 0
      while (i + k < aHi && j + k < bHi && a[i + k] === b[j + k]) k++
      if (k > bestSize) {
        bestI = i
        bestJ = j
        bestSize = k
      }
    }
  }
  return { i: bestI, j: bestJ, size: bestSize }
}

/** Total matched chars across all matching blocks (recursive subdivision). */
function matchedChars(a: string, b: string, aLo: number, aHi: number, bLo: number, bHi: number): number {
  const m = longestMatchSize(a, b, aLo, aHi, bLo, bHi)
  if (m.size === 0) return 0
  return (
    m.size +
    matchedChars(a, b, aLo, m.i, bLo, m.j) +
    matchedChars(a, b, m.i + m.size, aHi, m.j + m.size, bHi)
  )
}

/** difflib.SequenceMatcher.ratio() equivalent: 2*M / T. */
export function sequenceRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1
  const matches = matchedChars(a, b, 0, a.length, 0, b.length)
  return (2 * matches) / (a.length + b.length)
}

/**
 * Mirror of the fuzzy fallback in build_generator_prompts (assist.py:866-878):
 * exact path → difflib close match (n=1, cutoff 0.5) → first-segment prefix
 * match → the requested path unchanged.
 */
export function resolveContextPath(filepath: string, availablePaths: string[]): string {
  if (availablePaths.includes(filepath)) return filepath
  // difflib.get_close_matches(word, possibilities, n=1, cutoff=0.5): best
  // score wins; Python's sort is stable so ties keep the earliest candidate —
  // hence strict `>` here.
  let best: string | null = null
  let bestScore = -1
  for (const candidate of availablePaths) {
    const score = sequenceRatio(filepath, candidate)
    if (score >= 0.5 && score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  if (best !== null) return best
  const reqBase = filepath.split('/').pop()?.split('_')[0]?.toLowerCase() ?? ''
  for (const p of availablePaths) {
    if ((p.split('/').pop() ?? '').toLowerCase().startsWith(reqBase)) return p
  }
  return filepath
}

export interface GeneratorPromptInput {
  paragraphBefore: string
  targetParagraph: string
  paragraphAfter: string
  query: string
  contextNeeded: string[]
  availableFiles?: Array<{ path: string; name: string }>
  settings: AssistSettings
  /** Loaded simple-writer.md content. */
  writerPrompt: string
  readFile: AssistFileReader
}

/** Mirror of `build_generator_prompts` (assist.py:850-896).
 *
 * Prefix-cache layout: `system` is the frozen writer file only (preamble
 * state baked via buildStaticSystem). Referenced files — planner-selected
 * (resolved, then sorted so planner output order can't bust the prefix) and
 * pinned (sorted) — ship as their own `files` user message with
 * filename-explicit sections, so a query-only change reuses the files prefix.
 * The final `user` message carries just the anchor window + INSTRUCTION.
 */
export async function buildGeneratorPrompts(
  input: GeneratorPromptInput,
): Promise<{ system: string; files: string | null; user: string }> {
  const system = buildStaticSystem(input.writerPrompt, input.settings)

  const available = input.availableFiles ?? []
  const availablePaths = available.map((f) => f.path)
  const ignored = new Set(input.settings.ignored_ref_files ?? [])

  const resolved = sortUniquePaths(
    (input.contextNeeded ?? []).map((filepath) => resolveContextPath(filepath, availablePaths)),
  ).filter((p) => !isBlocked(p, ignored))
  const contextParts: string[] = []
  for (const actualPath of resolved) {
    await injectContextFile(contextParts, actualPath, actualPath, input.readFile)
  }
  const pinnedParts: string[] = []
  await injectPinnedRefFiles(pinnedParts, new Set(resolved), input.settings, available, input.readFile)
  const files = joinFilesMessage([...contextParts, ...pinnedParts])

  const userParts = [`PARAGRAPH_BEFORE:\n${input.paragraphBefore}`]
  if (input.targetParagraph) userParts.push(`TARGET:\n${input.targetParagraph}`)
  userParts.push(`PARAGRAPH_AFTER:\n${input.paragraphAfter}`)
  userParts.push(`INSTRUCTION:\n${input.query}`)

  return { system, files, user: userParts.join('\n\n') }
}

/* ------------------------------------------------------------------ */
/* Chat prompts (assist.py:937-981)                                    */
/* ------------------------------------------------------------------ */

export interface ComposeChatDeps {
  settings: AssistSettings
  /** Loaded simple-chat.md content. */
  chatPrompt: string
  readFile: AssistFileReader
  message?: string
  logs?: SimpleAssistLogEntry[]
  includeHistory?: boolean
}

/**
 * Mirror of `_compose_chat_prompts`.
 *
 * Prefix-cache layout: `system` is the frozen chat file only (preamble state
 * baked via buildStaticSystem) — history, files, and document context NEVER
 * touch it. Referenced files (@-tagged + pinned, sorted, filename-explicit
 * sections) ship as their own `files` user message. The final `user` message
 * carries RECENT_EDITS (edit_plan history, when includeHistory) → anchor
 * window (not the full document) → the user message last. Chat-turn history
 * is returned separately via buildChatHistoryMessages so the caller can send
 * real append-only user/assistant pairs between system and these messages.
 */
export async function composeChatMessages(
  req: SimpleAssistRequest,
  deps: ComposeChatDeps,
): Promise<{ system: string; history: ChatMessage[]; files: string | null; user: string }> {
  const message = deps.message ?? req.message
  const settings = deps.settings
  const system = buildStaticSystem(deps.chatPrompt, settings)

  const tagged = sortUniquePaths(taggedPaths(req))
  const fileParts: string[] = []
  if (tagged.length > 0) {
    const ignored = new Set(settings.ignored_ref_files ?? [])
    for (const p of tagged) {
      if (isBlocked(p, ignored)) continue
      await injectContextFile(fileParts, p, p, deps.readFile)
    }
  }
  await injectPinnedRefFiles(fileParts, new Set(tagged), settings, req.available_files, deps.readFile)
  const files = joinFilesMessage(fileParts)

  const userParts: string[] = []
  if (deps.includeHistory ?? true) {
    const edits = buildPlannerHistory(req.session_id ?? null, settings, deps.logs ?? [])
    if (edits) userParts.push(edits)
  }

  const content = req.content ?? ''
  if (content) {
    const anchor = extractAnchorContext(content, req.selected_text, req.cursor_paragraph_text)
    const anchorLines: string[] = []
    if (req.active_filename) anchorLines.push(`ACTIVE_FILE: ${req.active_filename}`)
    anchorLines.push(`PARAGRAPH_BEFORE:\n${anchor.paragraphBefore}`)
    if (anchor.targetParagraph) anchorLines.push(`TARGET:\n${anchor.targetParagraph}`)
    anchorLines.push(`PARAGRAPH_AFTER:\n${anchor.paragraphAfter}`)
    userParts.push(anchorLines.join('\n\n'))
  } else if (req.active_filename) {
    userParts.push(`ACTIVE_FILE: ${req.active_filename}`)
  }

  let userMessage = message
  if (req.selected_text) {
    userMessage = `SELECTED_TEXT:\n${req.selected_text}\n\nUSER_MESSAGE:\n${userMessage}`
  } else if (req.cursor_paragraph_text) {
    userMessage = `ANCHOR_PARAGRAPH_TEXT:\n${req.cursor_paragraph_text}\n\nUSER_MESSAGE:\n${userMessage}`
  }
  userParts.push(userMessage)

  const history =
    (deps.includeHistory ?? true) ? buildChatHistoryMessages(req.session_id ?? null, settings, deps.logs ?? []) : []

  return { system, history, files, user: userParts.join('\n\n') }
}

/**
 * Back-compat wrapper returning {system, user}. History pairs and the files
 * message are available via composeChatMessages — this wrapper folds files
 * into the user text and omits history (callers that need prefix reuse should
 * send system + history + files + user as separate messages).
 */
export async function composeChatPrompts(
  req: SimpleAssistRequest,
  deps: ComposeChatDeps,
): Promise<{ system: string; user: string }> {
  const built = await composeChatMessages(req, deps)
  return { system: built.system, user: built.files ? `${built.files}\n\n${built.user}` : built.user }
}

/* ------------------------------------------------------------------ */
/* Harness prompt assembly (assist.py:1023-1073)                        */
/* ------------------------------------------------------------------ */

export interface HarnessEditPromptInput {
  activePath?: string | null
  selectedText?: string | null
  cursorParagraphText?: string | null
  taggedFiles?: string[]
  instruction: string
  indexLine?: string
  /** Loaded harness-edit.md content (standing instructions). */
  systemPrompt: string
}

/**
 * Minimal-briefing prompt for harness edit mode (assist.py:1030-1058):
 * referent + instruction + index pointers. Harnesses plan and fetch context
 * themselves, so planner/writer plumbing is deliberately omitted.
 *
 * Prefix-cache layout: frozen system head; fixed user order
 * ACTIVE_FILE → SELECTED/ANCHOR → TAGGED (sorted) → INSTRUCTION →
 * index line; fixed `system + "\n\n" + user` join so the head stays stable
 * for downstream prefix reuse.
 */
export function buildHarnessEditPrompt(input: HarnessEditPromptInput): {
  system: string
  user: string
  harnessPrompt: string
} {
  const userParts: string[] = []
  if (input.activePath) userParts.push(`ACTIVE_FILE: ${input.activePath}`)
  if (input.selectedText) {
    userParts.push(`SELECTED_TEXT:\n${input.selectedText}`)
  } else if (input.cursorParagraphText) {
    userParts.push(`ANCHOR_PARAGRAPH_TEXT:\n${input.cursorParagraphText}`)
  }
  const tagged = sortUniquePaths(input.taggedFiles ?? [])
  if (tagged.length > 0) {
    userParts.push(`TAGGED_FILES (user explicitly attached — read them):\n${tagged.join('\n')}`)
  }
  userParts.push(`INSTRUCTION:\n${input.instruction}`)
  if (input.indexLine) userParts.push(input.indexLine)
  const user = userParts.join('\n\n')
  const system = normalizePromptText(input.systemPrompt ?? '')
  return { system, user, harnessPrompt: system ? `${system}\n\n${user}` : user }
}

/**
 * Harness chat assembly (assist.py:1064-1073): frozen system head + index
 * line + user message, fixed join. The harness owns its own LLM calls, so
 * this only preserves a stable head for downstream prefix reuse; session
 * affinity comes from the harness resume-id mapping.
 */
export function buildHarnessChatPrompt(input: {
  system: string
  userMessage: string
  indexLine?: string
}): { system: string; user: string; harnessPrompt: string } {
  const system = normalizePromptText(input.system)
  const user = `--- USER MESSAGE ---\n${input.userMessage}`
  const parts = [system]
  if (input.indexLine) parts.push(input.indexLine)
  parts.push(user)
  return { system, user: input.userMessage, harnessPrompt: parts.join('\n\n') }
}

/* ------------------------------------------------------------------ */
/* Session logs (assist.py:581-590, 601-659; file_storage.py:797-832)  */
/* ------------------------------------------------------------------ */

/**
 * DEVIATION: Python stores logs at <workspace>/outputs/ai_logs/<session>.json
 * (tied to the active workspace). This port stores them at
 * DATA_ROOT/assist-logs/<session>.json so history survives workspace
 * switches; the harness-session mapping side effect in
 * delete_simple_ai_logs_by_session is not ported (route-layer concern).
 */
export function defaultAssistLogsDir(dataRoot: string = DATA_ROOT): string {
  return join(dataRoot, 'assist-logs')
}

function randomHex(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += Math.floor(Math.random() * 16).toString(16)
  return out
}

export interface SimpleAssistLogInput {
  mode: string
  systemPrompt: string
  userPrompt: string
  response: string
  instruction: string
  sessionId?: string | null
  selectedText?: string | null
  textBefore?: string | null
  textAfter?: string | null
  refFiles?: Array<Record<string, unknown>> | null
  editMode?: string | null
  plannerSystemPrompt?: string | null
  plannerUserPrompt?: string | null
  plannerOutput?: string | null
  success?: boolean
  cursorParagraphIndex?: number | null
  modelUsed?: string | null
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  thinkingOutput?: string | null
  toolCalls?: Array<Record<string, unknown>> | null
}

/** Mirror of `_log_simple_assist`'s entry assembly (assist.py:601-659). */
export function buildSimpleAssistLogEntry(input: SimpleAssistLogInput): SimpleAssistLogEntry {
  const entry: SimpleAssistLogEntry = {
    id: `simple_${randomHex(32)}`,
    timestamp: new Date().toISOString(),
    mode: input.mode,
    session_id: input.sessionId ?? null,
    system_prompt: input.systemPrompt,
    user_prompt: input.userPrompt,
    output: input.response,
    instruction: input.instruction,
    selected_text: input.selectedText ?? null,
    text_before: input.textBefore ?? null,
    text_after: input.textAfter ?? null,
    ref_files: input.refFiles ?? null,
    success: input.success ?? true,
    prompt_tokens: input.promptTokens ?? 0,
    completion_tokens: input.completionTokens ?? 0,
    total_tokens: input.totalTokens ?? 0,
  }
  if (input.thinkingOutput != null) entry.thinking_output = input.thinkingOutput
  if (input.toolCalls && input.toolCalls.length > 0) entry.tool_calls = input.toolCalls
  if (input.editMode != null) entry.edit_mode = input.editMode
  if (input.plannerSystemPrompt != null) entry.planner_system_prompt = input.plannerSystemPrompt
  if (input.plannerUserPrompt != null) entry.planner_user_prompt = input.plannerUserPrompt
  if (input.plannerOutput != null) entry.planner_output = input.plannerOutput
  if (input.cursorParagraphIndex != null) entry.cursor_paragraph_index = input.cursorParagraphIndex
  if (input.modelUsed != null) entry.model_used = input.modelUsed
  return entry
}

/** Mirror of `get_simple_ai_logs`: all per-session files concatenated, sorted by timestamp. */
export async function getSimpleLogs(logsDir?: string): Promise<SimpleAssistLogEntry[]> {
  const dir = logsDir ?? defaultAssistLogsDir()
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f: string) => f.endsWith('.json'))
  } catch {
    return []
  }
  const all: SimpleAssistLogEntry[] = []
  for (const file of files) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, file), 'utf-8'))
      if (Array.isArray(parsed)) all.push(...(parsed as SimpleAssistLogEntry[]))
    } catch {
      /* skip corrupt session files, mirroring Python */
    }
  }
  all.sort((a, b) => ((a.timestamp ?? '') < (b.timestamp ?? '') ? -1 : 1))
  return all
}

/**
 * Mirror of `save_simple_ai_log`: append to the session file, capped at the
 * last 100 entries. Micro-deviation: Python writes "None.json" when
 * session_id is None; here null/empty maps to "default.json".
 */
export async function appendSimpleAssistLog(entry: SimpleAssistLogEntry, logsDir?: string): Promise<void> {
  const dir = logsDir ?? defaultAssistLogsDir()
  const sessionKey = typeof entry.session_id === 'string' && entry.session_id ? entry.session_id : 'default'
  const logsPath = join(dir, `${sessionKey}.json`)
  let logs: SimpleAssistLogEntry[] = []
  try {
    const parsed: unknown = JSON.parse(await readFile(logsPath, 'utf-8'))
    if (Array.isArray(parsed)) logs = parsed as SimpleAssistLogEntry[]
  } catch {
    logs = []
  }
  logs.push(entry)
  const capped = logs.slice(-100)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(logsPath, JSON.stringify(capped, null, 2), 'utf-8')
  } catch {
    /* best-effort logging, mirroring Python */
  }
}

/** Mirror of `delete_simple_ai_logs_by_session` (file removal half). */
export async function deleteSessionLogs(sessionId: string, logsDir?: string): Promise<void> {
  const dir = logsDir ?? defaultAssistLogsDir()
  try {
    await unlink(join(dir, `${sessionId}.json`))
  } catch {
    /* missing file is fine */
  }
}
