import { isChapterPath } from '../lib/chapters'
import {
  applyManualAction,
  readCharacterState,
  writeCharacterState,
} from './characters.server'
import {
  getActiveContextWindow,
  loadSimplePrompt,
  resolveSimpleAssistClientConfig,
  type AssistSettings,
} from './assist.server'
import { errMsg } from './http.server'
import { LLMClient } from './llm.server'
import { readWorkspaceFile } from './storage.server'

const REVIEW_DEBOUNCE_MS = 2500
const REVIEW_MAX_OUTPUT_TOKENS = 700
const REVIEW_STATIC_OVERHEAD_TOKENS = 1100
const REVIEW_MAX_CHAPTER_CHARS = 32_000

interface CurrentStateProposal {
  should_update: boolean
  location: string
  description: string
}

export interface CurrentStateReviewJob {
  workspaceDir: string
  filePath: string
  content: string
  settings: AssistSettings
}

interface WorkspaceReviewQueue {
  pending: Map<string, CurrentStateReviewJob>
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
}

const queues = new Map<string, WorkspaceReviewQueue>()

function parseReviewProposal(raw: string): CurrentStateProposal | null {
  let cleaned = raw.replace(/^\uFEFF/, '').trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

  let value: unknown
  try {
    value = JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      value = JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      return null
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.should_update !== 'boolean') return null
  return {
    should_update: record.should_update,
    location: typeof record.location === 'string' ? record.location.trim() : '',
    description: typeof record.description === 'string' ? record.description.trim() : '',
  }
}

function sameCurrentState(
  a: { location: string; description: string },
  b: { location: string; description: string },
): boolean {
  return a.location === b.location && a.description === b.description
}

/** Review a saved chapter and apply a clear current-state change, if warranted. */
export async function reviewCurrentStateFromChapter(job: CurrentStateReviewJob): Promise<boolean> {
  if (!isChapterPath(job.filePath) || !job.content.trim()) return false
  if (!job.settings.active_endpoint) return false

  const savedContent = await readWorkspaceFile(job.filePath, job.workspaceDir).catch(() => null)
  if (savedContent !== job.content) return false

  const initialState = await readCharacterState(job.workspaceDir)
  const config = resolveSimpleAssistClientConfig(job.settings)
  const systemPrompt = await loadSimplePrompt('current-state-reviewer.md')
  if (!systemPrompt.trim()) return false

  const contextWindow = getActiveContextWindow(job.settings)
  const chapterBudget = Math.max(
    1000,
    Math.min(
      REVIEW_MAX_CHAPTER_CHARS,
      Math.floor(
        (contextWindow - REVIEW_STATIC_OVERHEAD_TOKENS - REVIEW_MAX_OUTPUT_TOKENS) * 2.5,
      ),
    ),
  )
  const chapterText = job.content.trim()
  const chapterExcerpt = chapterText.length > chapterBudget
    ? `[Earlier chapter text omitted; this excerpt contains the chapter ending.]\n${chapterText.slice(-chapterBudget)}`
    : chapterText
  const userPrompt = [
    `UPDATED CHAPTER PATH: ${job.filePath}`,
    '',
    'CURRENT STATE:',
    JSON.stringify(initialState.current_state),
    '',
    'UPDATED CHAPTER TEXT:',
    chapterExcerpt,
    '',
    'Return the required JSON decision only.',
  ].join('\n')

  const client = new LLMClient({
    model: config.model ?? undefined,
    baseUrl: config.baseUrl ?? undefined,
    apiKey: config.apiKey ?? undefined,
    isThinking: config.isThinking,
    customOpeningTags: config.customOpeningTags,
    customClosingTags: config.customClosingTags,
  })
  const raw = await client.generateBlocking(systemPrompt, userPrompt, {
    temperature: 0.1,
    maxTokens: REVIEW_MAX_OUTPUT_TOKENS,
    enableThinking: false,
  })
  const proposal = parseReviewProposal(raw)
  if (!proposal?.should_update) return false

  // Avoid applying a result for a document that was saved again while the
  // background review was running.
  const latestContent = await readWorkspaceFile(job.filePath, job.workspaceDir).catch(() => null)
  if (latestContent !== job.content) return false

  // Preserve a manual edit or a newer review that landed while this call was
  // in flight. Re-read all fields so the character list is not based on the
  // stale snapshot used to prompt the model.
  const latestState = await readCharacterState(job.workspaceDir)
  if (!sameCurrentState(latestState.current_state, initialState.current_state)) return false

  const next = applyManualAction(latestState, {
    action: 'update_current_state',
    current_state: {
      location: proposal.location || latestState.current_state.location,
      description: proposal.description || latestState.current_state.description,
    },
  })
  if (sameCurrentState(next.current_state, latestState.current_state)) return false

  await writeCharacterState(job.workspaceDir, next)
  return true
}

async function drainQueue(workspaceDir: string, queue: WorkspaceReviewQueue): Promise<void> {
  if (queue.running) return
  if (queue.timer) clearTimeout(queue.timer)
  queue.timer = null
  queue.running = true

  const jobs = [...queue.pending.values()]
  queue.pending.clear()
  try {
    for (const job of jobs) {
      try {
        await reviewCurrentStateFromChapter(job)
      } catch (error) {
        console.warn(
          `Background current-state review failed for ${job.filePath}: ${errMsg(error)}`,
        )
      }
    }
  } finally {
    queue.running = false
    if (queue.pending.size > 0) {
      queue.timer = setTimeout(() => void drainQueue(workspaceDir, queue), REVIEW_DEBOUNCE_MS)
    } else {
      queues.delete(workspaceDir)
    }
  }
}

/** Debounce save bursts and serialize chapter reviews within each workspace. */
export function scheduleCurrentStateReview(job: CurrentStateReviewJob): void {
  if (!job.settings.active_endpoint || !isChapterPath(job.filePath)) return

  let queue = queues.get(job.workspaceDir)
  if (!queue) {
    queue = { pending: new Map(), timer: null, running: false }
    queues.set(job.workspaceDir, queue)
  }
  queue.pending.set(job.filePath, job)
  if (queue.timer) clearTimeout(queue.timer)
  queue.timer = setTimeout(() => void drainQueue(job.workspaceDir, queue!), REVIEW_DEBOUNCE_MS)
}
