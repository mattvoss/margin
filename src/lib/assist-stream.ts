import type { WritingEvaluationRecord } from './writingEvaluation'

export type AssistMode = 'chat' | 'edit' | 'write' | 'planner' | 'planner_draft'
export type AssistStageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface AssistStageState {
  id: string
  label?: string
  status: AssistStageStatus
  reasoning: string
  output: string
  tools: Array<{ name: string; detail?: string }>
  error?: string
}

export type AssistStreamEvent =
  | { type: 'reset' }
  | { type: 'run_started'; runId?: string; mode: AssistMode; model?: string; endpointId?: string }
  | { type: 'stage_started'; stage: string; label?: string }
  | { type: 'reasoning_delta'; stage: string; delta: string }
  | { type: 'text_delta'; stage: string; delta: string }
  | { type: 'tool'; stage: string; name: string; detail?: string }
  | { type: 'stage_completed'; stage: string; output?: string; reasoning?: string }
  | { type: 'questionnaire'; questions: unknown[] }
  | { type: 'evaluation_started' }
  | { type: 'evaluation_completed'; evaluation: WritingEvaluationRecord }
  | { type: 'evaluation_failed'; message: string }
  | { type: 'evaluation_skipped' }
  | { type: 'rewrite_candidate'; output: string; iterations: number }
  | { type: 'completed'; output: string; reasoning?: string }
  | { type: 'failed'; stage?: string; message: string }
  | { type: 'cancelled'; stage?: string }

export interface AssistRunState {
  runId: string | null
  mode: AssistMode | null
  model: string | null
  endpointId: string | null
  stages: Record<string, AssistStageState>
  stageOrder: string[]
  finalOutput: string
  finalReasoning: string
  questions: unknown[]
  evaluation: WritingEvaluationRecord | null
  evaluationRunning: boolean
  error: string | null
  complete: boolean
}

export const initialAssistRunState: AssistRunState = {
  runId: null,
  mode: null,
  model: null,
  endpointId: null,
  stages: {},
  stageOrder: [],
  finalOutput: '',
  finalReasoning: '',
  questions: [],
  evaluation: null,
  evaluationRunning: false,
  error: null,
  complete: false,
}

function ensureStage(state: AssistRunState, id: string, label?: string): AssistStageState {
  return state.stages[id] ?? {
    id,
    label,
    status: 'pending',
    reasoning: '',
    output: '',
    tools: [],
  }
}

export function reduceAssistStream(
  state: AssistRunState,
  event: AssistStreamEvent,
): AssistRunState {
  switch (event.type) {
    case 'reset':
      return initialAssistRunState
    case 'run_started':
      return {
        ...initialAssistRunState,
        runId: event.runId ?? null,
        mode: event.mode,
        model: event.model ?? null,
        endpointId: event.endpointId ?? null,
      }
    case 'stage_started': {
      const stage = ensureStage(state, event.stage, event.label)
      return {
        ...state,
        stages: { ...state.stages, [event.stage]: { ...stage, label: event.label ?? stage.label, status: 'running', error: undefined } },
        stageOrder: state.stageOrder.includes(event.stage) ? state.stageOrder : [...state.stageOrder, event.stage],
      }
    }
    case 'reasoning_delta': {
      const stage = ensureStage(state, event.stage)
      return { ...state, stages: { ...state.stages, [event.stage]: { ...stage, reasoning: stage.reasoning + event.delta } } }
    }
    case 'text_delta': {
      const stage = ensureStage(state, event.stage)
      return { ...state, stages: { ...state.stages, [event.stage]: { ...stage, output: stage.output + event.delta } } }
    }
    case 'tool': {
      const stage = ensureStage(state, event.stage)
      return { ...state, stages: { ...state.stages, [event.stage]: { ...stage, tools: [...stage.tools, { name: event.name, detail: event.detail }] } } }
    }
    case 'stage_completed': {
      const stage = ensureStage(state, event.stage)
      return {
        ...state,
        stages: { ...state.stages, [event.stage]: { ...stage, status: 'completed', output: event.output ?? stage.output, reasoning: event.reasoning ?? stage.reasoning } },
        stageOrder: state.stageOrder.includes(event.stage) ? state.stageOrder : [...state.stageOrder, event.stage],
      }
    }
    case 'questionnaire':
      return { ...state, questions: event.questions }
    case 'evaluation_started':
      return { ...state, evaluation: null, evaluationRunning: true }
    case 'evaluation_completed':
      return { ...state, evaluation: event.evaluation, evaluationRunning: false }
    case 'evaluation_failed':
      return {
        ...state,
        evaluation: { status: 'failed', message: event.message.slice(0, 300) },
        evaluationRunning: false,
      }
    case 'evaluation_skipped':
      return { ...state, evaluation: { status: 'skipped', reason: 'disabled' }, evaluationRunning: false }
    case 'rewrite_candidate':
      return { ...state, finalOutput: event.output }
    case 'completed':
      return { ...state, finalOutput: event.output, finalReasoning: event.reasoning ?? state.finalReasoning, complete: true }
    case 'failed': {
      const stages = event.stage
        ? { ...state.stages, [event.stage]: { ...ensureStage(state, event.stage), status: 'failed', error: event.message } }
        : state.stages
      return { ...state, stages, error: event.message, complete: true }
    }
    case 'cancelled':
      return {
        ...state,
        complete: true,
        stages: event.stage ? { ...state.stages, [event.stage]: { ...ensureStage(state, event.stage), status: 'cancelled' } } : state.stages,
      }
  }
}
