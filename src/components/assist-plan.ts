export type AssistPlanStepStatus = 'done' | 'running' | 'pending' | 'error'

export interface AssistPlanStep {
  id: string
  title: string
  status: AssistPlanStepStatus
  description?: string
}

export function buildAssistPlan(input: {
  mode: 'chat' | 'edit'
  harnessActive: boolean
  harnessName?: string
  isPlanning: boolean
  isGenerating: boolean
  postProcess?: {
    index: number
    total: number
    name?: string
    phase?: 'running' | 'done' | 'error'
  } | null
}): { title: string; steps: AssistPlanStep[] } {
  const postProcessActive = !!input.postProcess
  const steps: AssistPlanStep[] = []

  if (input.mode === 'edit' && !input.harnessActive) {
    steps.push({
      id: 'planner',
      title: 'Planner agent',
      status: input.isPlanning
        ? 'running'
        : input.isGenerating || postProcessActive
          ? 'done'
          : 'pending',
    })
    steps.push({
      id: 'writer',
      title: 'Editing agent',
      status: postProcessActive
        ? 'done'
        : input.isGenerating
          ? 'running'
          : 'pending',
    })
  } else {
    const responseStatus = postProcessActive
      ? 'done'
      : input.isPlanning || input.isGenerating
        ? 'running'
        : 'pending'
    steps.push({
      id: 'response',
      title:
        input.mode === 'chat'
          ? 'Chat agent'
          : `${input.harnessName || 'Agent'} run`,
      status: responseStatus,
    })
  }

  if (input.postProcess) {
    const { index, total, name, phase } = input.postProcess
    const currentPass = total > 0 ? Math.min(index + 1, total) : index + 1
    const allPassesDone = phase === 'done' && (total <= 0 || currentPass >= total)
    steps.push({
      id: 'post-process',
      title: name ? `Post-processing · ${name}` : 'Post-processing',
      status: phase === 'error' ? 'error' : allPassesDone ? 'done' : 'running',
      description: total > 0 ? `${currentPass} of ${total} passes` : undefined,
    })
  }

  return {
    title: input.mode === 'chat' ? 'Plan: answer in chat' : 'Plan: edit request',
    steps,
  }
}
