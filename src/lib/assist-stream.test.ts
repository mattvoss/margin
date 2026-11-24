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

  it('retains subagent task, model, tools, thinking, result and failure state', () => {
    let state = reduceAssistStream(initialAssistRunState, {
      type: 'run_started',
      mode: 'edit',
    })
    state = reduceAssistStream(state, {
      type: 'stage_started',
      stage: 'planner',
      label: 'Planner',
      task: 'Choose the next scene beats.',
      model: 'example/model',
    })
    state = reduceAssistStream(state, {
      type: 'tool',
      stage: 'planner',
      name: 'search_memory',
      detail: 'character motivation',
    })
    state = reduceAssistStream(state, {
      type: 'reasoning_delta',
      stage: 'planner',
      delta: 'Keep the goal unresolved.',
    })
    state = reduceAssistStream(state, {
      type: 'stage_completed',
      stage: 'planner',
      output: 'Three scene beats.',
    })

    expect(state.stages.planner).toMatchObject({
      status: 'completed',
      task: 'Choose the next scene beats.',
      model: 'example/model',
      reasoning: 'Keep the goal unresolved.',
      output: 'Three scene beats.',
      tools: [{ name: 'search_memory', detail: 'character motivation' }],
    })

    state = reduceAssistStream(state, {
      type: 'stage_failed',
      stage: 'writer',
      message: 'The writer endpoint is unavailable.',
    })
    expect(state.stages.writer).toMatchObject({
      status: 'failed',
      error: 'The writer endpoint is unavailable.',
    })
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

  it('replaces the displayed candidate only when an explicit rewrite event arrives', () => {
    const state = reduceAssistStream(
      { ...initialAssistRunState, finalOutput: 'Original.' },
      { type: 'rewrite_candidate', output: 'Revised.', iterations: 1 },
    )
    expect(state.finalOutput).toBe('Revised.')
  })

  it('resets the run state to its initial value', () => {
    const active = reduceAssistStream(initialAssistRunState, {
      type: 'run_started',
      mode: 'write',
      runId: 'run-1',
    })
    const withOutput = reduceAssistStream(active, {
      type: 'text_delta',
      stage: 'prose',
      delta: 'A draft.',
    })

    expect(reduceAssistStream(withOutput, { type: 'reset' })).toEqual(initialAssistRunState)
  })
})
