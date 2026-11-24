import { describe, expect, it } from 'vitest'
import { normalizeAssistEvent } from './stream-sse'

describe('normalizeAssistEvent', () => {
  it('normalizes legacy reasoning and prose events', () => {
    expect(normalizeAssistEvent({ status: 'thinking_chunk', stage: 'planner', chunk: 'Considering…' })).toEqual({
      type: 'reasoning_delta', stage: 'planner', delta: 'Considering…',
    })
    expect(normalizeAssistEvent({ status: 'chunk', chunk: 'Answer' })).toEqual({
      type: 'text_delta', stage: 'response', delta: 'Answer',
    })
  })

  it('passes through normalized events', () => {
    const event = { type: 'reasoning_delta', stage: 'plan', delta: 'Think' } as const
    expect(normalizeAssistEvent(event)).toEqual(event)
  })

  it('normalizes writing evaluation lifecycle events', () => {
    expect(normalizeAssistEvent({ status: 'write_evaluation_started' })).toEqual({ type: 'evaluation_started' })
    expect(normalizeAssistEvent({ status: 'write_evaluation_failed', message: 'Unavailable.' })).toEqual({
      type: 'evaluation_failed', message: 'Unavailable.',
    })
    expect(normalizeAssistEvent({ status: 'write_evaluation_skipped', reason: 'disabled' })).toEqual({
      type: 'evaluation_skipped',
    })
    expect(normalizeAssistEvent({ status: 'write_evaluation_completed', evaluation: { version: 1 } })).toEqual({
      type: 'evaluation_completed',
      evaluation: { status: 'complete', result: { version: 1 } },
    })
  })
})
