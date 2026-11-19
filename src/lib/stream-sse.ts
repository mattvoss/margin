import { apiFetch } from './api'
import type { AssistStreamEvent } from './assist-stream'

export function normalizeAssistEvent(data: Record<string, unknown>): AssistStreamEvent | null {
  if (typeof data.type === 'string') return data as unknown as AssistStreamEvent
  const status = typeof data.status === 'string' ? data.status : ''
  if (status === 'thinking_chunk') return { type: 'reasoning_delta', stage: typeof data.stage === 'string' ? data.stage : 'response', delta: String(data.chunk ?? '') }
  if (status === 'write_reasoning') return { type: 'reasoning_delta', stage: String(data.stage ?? 'write'), delta: String(data.chunk ?? '') }
  if (status === 'chunk' || status === 'write_prose') return { type: 'text_delta', stage: status === 'write_prose' ? 'prose' : 'response', delta: String(data.chunk ?? '') }
  if (status === 'tool') return { type: 'tool', stage: String(data.stage ?? 'response'), name: String(data.tool ?? 'tool'), detail: typeof data.detail === 'string' ? data.detail : undefined }
  if (status === 'write_started') return { type: 'run_started', mode: 'write', runId: typeof data.run_id === 'string' ? data.run_id : undefined }
  if (status === 'write_stage_started') return { type: 'stage_started', stage: String(data.stage ?? 'write') }
  if (status === 'write_stage_completed') return { type: 'stage_completed', stage: String(data.stage ?? 'write'), output: typeof data.output === 'string' ? data.output : undefined }
  if (status === 'write_completed' || status === 'chat') return { type: 'completed', output: String(data.output ?? '') }
  if (status === 'error') return { type: 'failed', message: String(data.message ?? data.error ?? 'Assist request failed') }
  return null
}

export async function streamSSE(
  url: string,
  body: Record<string, unknown>,
  onEvent: (type: string, data: Record<string, unknown>) => void,
  signal?: AbortSignal,
  onNormalizedEvent?: (event: AssistStreamEvent) => void,
): Promise<void> {
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let detail: string | null = null
    try {
      const data = await res.json()
      if (data && typeof data.detail === 'string' && data.detail.trim()) {
        detail = data.detail
      }
    } catch {
      // Non-JSON body — fall through to the bare status below.
    }
    throw new Error(detail ?? `Request failed: ${res.status}`)
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const clean = line.trim()
      if (!clean.startsWith('data: ')) continue
      try {
        const data = JSON.parse(clean.slice(6))
         const event = normalizeAssistEvent(data)
         onEvent(String(data.status ?? data.type ?? ''), data)
         if (event) onNormalizedEvent?.(event)
      } catch (e) {
        console.error('Error parsing stream chunk:', e)
      }
    }
  }
}
