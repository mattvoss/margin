import { describe, expect, it } from 'vitest'
import { initialAssistRunState, reduceAssistStream } from './assist-stream'

describe('reduceAssistStream', () => {
  it('retains independent reasoning and output for multiple stages', () => {
    let state = reduceAssistStream(initialAssistRunState, { type: 'run_started', mode: 'write', runId: 'run-1' })
    state = reduceAssistStream(state, { type: 'stage_started', stage: 'plan', label: 'Plan' })
    state = reduceAssistStream(state, { type: 'reasoning_delta', stage: 'plan', delta: 'Think ' })
    state = reduceAssistStream(state, { type: 'reasoning_delta', stage: 'plan', delta: 'first.' })
    state = reduceAssistStream(state, { type: 'stage_started', stage: 'prose', label: 'Prose' })
    state = reduceAssistStream(state, { type: 'reasoning_delta', stage: 'prose', delta: 'Write.' })
    state = reduceAssistStream(state, { type: 'text_delta', stage: 'prose', delta: 'A scene.' })

    expect(state.stages.plan.reasoning).toBe('Think first.')
    expect(state.stages.prose.reasoning).toBe('Write.')
    expect(state.stages.prose.output).toBe('A scene.')
  })

  it('keeps final output after completion and records stage failures', () => {
    let state = reduceAssistStream(initialAssistRunState, { type: 'run_started', mode: 'chat' })
    state = reduceAssistStream(state, { type: 'stage_started', stage: 'response' })
    state = reduceAssistStream(state, { type: 'completed', output: 'Finished.' })
    expect(state.complete).toBe(true)
    expect(state.finalOutput).toBe('Finished.')

    state = reduceAssistStream(state, { type: 'failed', stage: 'response', message: 'Provider failed' })
    expect(state.error).toBe('Provider failed')
    expect(state.stages.response.status).toBe('failed')
  })

  it('tracks advisory evaluation without changing the generated output', () => {
    let state = reduceAssistStream(initialAssistRunState, { type: 'run_started', mode: 'write' })
    state = reduceAssistStream(state, { type: 'text_delta', stage: 'prose', delta: 'A draft.' })
    state = reduceAssistStream(state, { type: 'evaluation_started' })
    expect(state.evaluationRunning).toBe(true)
    state = reduceAssistStream(state, {
      type: 'evaluation_failed',
      message: 'Unavailable; draft remains reviewable.',
    })
    expect(state.evaluationRunning).toBe(false)
    expect(state.evaluation).toMatchObject({ status: 'failed' })
    expect(state.stages.prose.output).toBe('A draft.')
  })
})
