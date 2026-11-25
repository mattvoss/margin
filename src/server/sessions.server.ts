/**
 * Margin session state: harness-session resume map, per-session abort
 * controllers for the stop endpoint, and simple-assist ai_logs.
 *
 * Mirrors api/services/file_storage.py harness-session helpers
 * (_harness_sessions_path, get/set/clear_harness_session),
 * save_simple_ai_log / get_simple_ai_logs / delete_simple_ai_logs_by_session,
 * and the _active_stop_events dict in api/routers/assist.py.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_ROOT } from './env.server'
import { getActiveWorkspaceDir } from './storage.server'
import type { WritingEvaluationRecord } from '../lib/writingEvaluation'

export interface AiLogEntry {
  id: string
  timestamp: string
  mode: string
  session_id: string | null
  system_prompt: string
  user_prompt: string
  output: string
  /** Writer/chat output before post-processing, when a pipeline ran. */
  raw_output?: string | null
  /** Post-processing summary: passes, models, usage, snapshots. */
  post_processing?: unknown
  /** Bounded advisory report for the dedicated writing pipeline. */
  writing_evaluation?: WritingEvaluationRecord
  instruction: string
  selected_text?: string | null
  text_before?: string | null
  text_after?: string | null
  ref_files?: unknown
  success: boolean
  prompt_tokens: number
  /** Peak single-step prompt size for multi-step agent context displays. */
  context_prompt_tokens?: number | null
  completion_tokens: number
  total_tokens: number
  thinking_output?: string | null
  tool_calls?: unknown
  edit_mode?: string | null
  planner_system_prompt?: string | null
  planner_user_prompt?: string | null
  planner_output?: string | null
  cursor_paragraph_index?: number | null
  model_used?: string | null
  /** Prefix-cache diagnostics (Step 0/7): stable hashes + server telemetry. */
  system_hash?: string | null
  user_hash?: string | null
  prompt_ms?: number | null
  tokens_cached?: number | null
  slot_id?: number | null
  logprobs_requested?: boolean
  logprobs_received?: boolean
  logprob_token_count?: number
}

function rid(prefix: string): string {
  return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
}

// --- harness sessions (DATA_ROOT/harness_sessions.json) ---

async function sessionsPath(): Promise<string> {
  await mkdir(DATA_ROOT, { recursive: true })
  return join(DATA_ROOT, 'harness_sessions.json')
}

async function loadSessions(): Promise<Record<string, Record<string, string>>> {
  try {
    const raw = await readFile(await sessionsPath(), 'utf-8')
    const data = JSON.parse(raw) as unknown
    if (data && typeof data === 'object') return data as Record<string, Record<string, string>>
  } catch {
    // missing or corrupt -> empty
  }
  return {}
}

export async function getHarnessSession(sessionId: string, harnessId: string): Promise<string | null> {
  const entry = (await loadSessions())[sessionId]
  const v = entry?.[harnessId]
  return typeof v === 'string' ? v : null
}

export async function setHarnessSession(
  sessionId: string,
  harnessId: string,
  harnessSessionId: string,
): Promise<void> {
  if (!sessionId || !harnessSessionId) return
  const data = await loadSessions()
  data[sessionId] = { ...(data[sessionId] ?? {}), [harnessId]: harnessSessionId }
  await writeFile(await sessionsPath(), JSON.stringify(data, null, 2), 'utf-8')
}

export async function clearHarnessSession(sessionId: string, harnessId?: string | null): Promise<void> {
  const data = await loadSessions()
  if (!data[sessionId]) return
  if (harnessId) {
    delete data[sessionId]?.[harnessId]
    if (Object.keys(data[sessionId] ?? {}).length === 0) delete data[sessionId]
  } else {
    delete data[sessionId]
  }
  await writeFile(await sessionsPath(), JSON.stringify(data, null, 2), 'utf-8')
}

// --- abort controllers for POST /simple/stop/{id} ---

const activeControllers = new Map<string, AbortController>()

export interface PendingWriteClarification {
  id: string
  sessionId: string | null
  expiresAt: number
  originalMessage: string
  context: string
  messages: unknown[]
  answers: Record<string, string>
  rounds: number
  toolCallId: string
  toolInput: unknown
  /** All ask_user calls emitted in one clarification turn. */
  toolCalls?: Array<{ toolCallId: string; toolInput: unknown }>
}

const pendingWriteClarifications = new Map<string, PendingWriteClarification>()
const PENDING_CLARIFICATION_TTL_MS = 15 * 60 * 1000
const MAX_PENDING_CLARIFICATIONS = 256

function prunePendingWriteClarifications(now = Date.now()): void {
  for (const [id, pending] of pendingWriteClarifications) {
    if (pending.expiresAt <= now) pendingWriteClarifications.delete(id)
  }
}

export function savePendingWriteClarification(
  pending: Omit<PendingWriteClarification, 'id' | 'expiresAt'>,
): PendingWriteClarification {
  prunePendingWriteClarifications()
  while (pendingWriteClarifications.size >= MAX_PENDING_CLARIFICATIONS) {
    const oldest = [...pendingWriteClarifications.values()].sort(
      (a, b) => a.expiresAt - b.expiresAt,
    )[0]
    if (!oldest) break
    pendingWriteClarifications.delete(oldest.id)
  }
  const saved = {
    ...pending,
    id: randomUUID(),
    expiresAt: Date.now() + PENDING_CLARIFICATION_TTL_MS,
  }
  pendingWriteClarifications.set(saved.id, saved)
  return saved
}

/** Restore a claimed turn when its model continuation fails before completion. */
export function restorePendingWriteClarification(pending: PendingWriteClarification): void {
  prunePendingWriteClarifications()
  if (pending.expiresAt <= Date.now()) return
  if (pendingWriteClarifications.size >= MAX_PENDING_CLARIFICATIONS) {
    const oldest = [...pendingWriteClarifications.values()].sort(
      (a, b) => a.expiresAt - b.expiresAt,
    )[0]
    if (oldest) pendingWriteClarifications.delete(oldest.id)
  }
  pendingWriteClarifications.set(pending.id, pending)
}

/** Take is single-use so replaying a clarification ID cannot duplicate a turn. */
export function takePendingWriteClarification(
  id: string,
  sessionId: string | null,
): PendingWriteClarification | null {
  prunePendingWriteClarifications()
  const pending = pendingWriteClarifications.get(id)
  if (!pending || pending.sessionId !== sessionId) return null
  pendingWriteClarifications.delete(id)
  return pending
}

export function getPendingWriteClarification(
  id: string,
  sessionId: string | null,
): PendingWriteClarification | null {
  prunePendingWriteClarifications()
  const pending = pendingWriteClarifications.get(id)
  return pending?.sessionId === sessionId ? pending : null
}

export function clearPendingWriteClarifications(sessionId: string | null): void {
  for (const [id, pending] of pendingWriteClarifications) {
    if (pending.sessionId === sessionId) pendingWriteClarifications.delete(id)
  }
}

export function registerController(sessionId: string): AbortController {
  const c = new AbortController()
  activeControllers.set(sessionId, c)
  return c
}

export function stopSession(sessionId: string): boolean {
  clearPendingWriteClarifications(sessionId)
  const c = activeControllers.get(sessionId)
  if (!c) return false
  try {
    c.abort()
  } catch {
    // ignore
  }
  activeControllers.delete(sessionId)
  return true
}

export function releaseController(sessionId: string): void {
  activeControllers.delete(sessionId)
}

// --- simple-assist ai_logs (<workspace>/outputs/ai_logs/<session>.json) ---

async function logsDir(workspaceDir?: string): Promise<string> {
  const ws = workspaceDir ?? (await getActiveWorkspaceDir())
  const d = join(ws, 'outputs', 'ai_logs')
  await mkdir(d, { recursive: true })
  return d
}

export async function saveSimpleAiLog(
  entry: Omit<AiLogEntry, 'id' | 'timestamp'>,
  workspaceDir?: string,
): Promise<AiLogEntry> {
  const full: AiLogEntry = {
    ...entry,
    id: rid('simple'),
    timestamp: new Date().toISOString(),
  }
  const dir = await logsDir(workspaceDir)
  const key = String(entry.session_id ?? 'default')
  const p = join(dir, `${key}.json`)
  let logs: AiLogEntry[]
  try {
    logs = JSON.parse(await readFile(p, 'utf-8')) as AiLogEntry[]
    if (!Array.isArray(logs)) logs = []
  } catch {
    logs = []
  }
  logs.push(full)
  await writeFile(p, JSON.stringify(logs.slice(-100), null, 2), 'utf-8')
  return full
}

export async function deleteSessionLogs(sessionId: string, workspaceDir?: string): Promise<void> {
  clearPendingWriteClarifications(sessionId)
  const dir = await logsDir(workspaceDir)
  try {
    await rm(join(dir, `${sessionId}.json`), { force: true })
  } catch {
    // ignore
  }
  await clearHarnessSession(sessionId)
}

/**
 * Read workspace ai_logs for prefix-cache history (chat pairs, planner
 * RECENT_EDITS). Returns all entries sorted by timestamp; pass a sessionId to
 * filter. Corrupt files are skipped, mirroring the logs route.
 */
export async function getWorkspaceAiLogs(workspaceDir?: string, sessionId?: string | null): Promise<AiLogEntry[]> {
  const dir = await logsDir(workspaceDir)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const all: AiLogEntry[] = []
  for (const file of files) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, file), 'utf-8'))
      if (Array.isArray(parsed)) all.push(...(parsed as AiLogEntry[]))
    } catch {
      // skip corrupt session files
    }
  }
  all.sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')))
  if (sessionId != null) return all.filter((l) => l.session_id === sessionId)
  return all
}
