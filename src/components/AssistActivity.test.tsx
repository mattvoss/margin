// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ReasoningTrace,
  ToolTrace,
} from './AssistActivity'
import { Subagent } from './ai-elements/subagent'

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

  it('renders a subagent run with task, thinking, steps, and result', () => {
    const markup = renderToStaticMarkup(
      <Subagent
        name="Planner"
        status="completed"
        model="example/model"
        task="Choose the next scene beats."
        thinking="The scene should preserve the character's unresolved goal."
        steps={[{ name: 'search_memory', detail: 'Found the active character motivation.' }]}
        result={'{"beats":["Mara reaches the station"]}'}
      />,
    )
    expect(markup).toContain('Ran Planner subagent')
    expect(markup).toContain('example/model')
    expect(markup).toContain('search_memory')
    expect(markup).toContain('Thinking')
    expect(markup).toContain('The scene should preserve')
    expect(markup).toContain('Found the active character motivation.')
    expect(markup).toContain('Mara reaches the station')
  })

  it('renders a running subagent as expanded progress', () => {
    const markup = renderToStaticMarkup(
      <Subagent name="Editing" status="running" task="Revise the passage." thinking="Checking continuity." />,
    )
    expect(markup).toContain('Running Editing subagent')
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('Checking continuity.')
  })
})
