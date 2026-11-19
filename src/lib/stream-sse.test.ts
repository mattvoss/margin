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
})
