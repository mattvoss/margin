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

  it('normalizes subagent lifecycle data into stage runs', () => {
    expect(normalizeAssistEvent({
      status: 'subagent_started',
      subagent: 'planner',
      name: 'Planner',
      task: 'Choose scene beats.',
      model_used: 'example/model',
    })).toEqual({
      type: 'stage_started',
      stage: 'planner',
      label: 'Planner',
      task: 'Choose scene beats.',
      model: 'example/model',
    })
    expect(normalizeAssistEvent({
      status: 'subagent_completed',
      subagent: 'planner',
      result: 'Three beats.',
      thinking: 'Preserve the goal.',
    })).toEqual({
      type: 'stage_completed',
      stage: 'planner',
      output: 'Three beats.',
      reasoning: 'Preserve the goal.',
    })
    expect(normalizeAssistEvent({
      status: 'subagent_failed',
      subagent: 'planner',
      message: 'Planner unavailable.',
    })).toEqual({
      type: 'stage_failed',
      stage: 'planner',
      message: 'Planner unavailable.',
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

  it('normalizes optional rewrite candidates', () => {
    expect(normalizeAssistEvent({ status: 'write_rewrite_candidate', output: 'Revised.', iterations: 2 })).toEqual({
      type: 'rewrite_candidate', output: 'Revised.', iterations: 2,
    })
  })
})
