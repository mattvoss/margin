// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AssistPlanTrace,
  ReasoningTrace,
  ToolTrace,
} from './AssistActivity'
import { buildAssistPlan } from './assist-plan'

describe('SimpleAssist AI activity elements', () => {
  it('renders live reasoning as an open, running trace', () => {
    const markup = renderToStaticMarkup(
      <ReasoningTrace text="Checking the selected passage." running />,
    )

    expect(markup).toContain('Thinking…')
    expect(markup).toContain('Checking the selected passage.')
    expect(markup).toContain('data-status="running"')
  })

  it('renders saved reasoning as a closed thought trace', () => {
    const markup = renderToStaticMarkup(<ReasoningTrace text="The scene needs a quieter ending." />)

    expect(markup).toContain('Thought')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('data-status="running"')
  })

  it('renders tool activity as collapsible Trace elements', () => {
    const markup = renderToStaticMarkup(
      <>
        <ToolTrace tool="read_file" detail="Reading notes/scene.md" running />
        <ToolTrace tool="finish" detail="Response ready" />
      </>,
    )

    expect(markup).toContain('Running read_file')
    expect(markup).toContain('Tool · finish')
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(2)
  })

  it('renders agent and post-processing stages in the documented Plan trace', () => {
    const planning = buildAssistPlan({
      mode: 'edit',
      harnessActive: false,
      isPlanning: true,
      isGenerating: false,
    })
    expect(planning.steps.map((step) => [step.title, step.status])).toEqual([
      ['Planner agent', 'running'],
      ['Editing agent', 'pending'],
    ])

    const postProcessing = buildAssistPlan({
      mode: 'edit',
      harnessActive: false,
      isPlanning: false,
      isGenerating: true,
      postProcess: { index: 1, total: 3, name: 'Continuity', phase: 'running' },
    })
    expect(postProcessing.steps.map((step) => step.status)).toEqual([
      'done',
      'done',
      'running',
    ])

    const failedPass = buildAssistPlan({
      mode: 'edit',
      harnessActive: false,
      isPlanning: false,
      isGenerating: true,
      postProcess: { index: 0, total: 1, name: 'Continuity', phase: 'error' },
    })
    expect(failedPass.steps.at(-1)?.status).toBe('error')

    const markup = renderToStaticMarkup(
      <AssistPlanTrace title={postProcessing.title} steps={postProcessing.steps} />,
    )
    expect(markup).toContain('Plan: edit request')
    expect(markup).toContain('2 of 3 done')
    expect(markup).toContain('Planner agent')
    expect(markup).toContain('Editing agent')
    expect(markup).toContain('Post-processing · Continuity')
    expect(markup).toContain('2 of 3 passes')
  })
})
