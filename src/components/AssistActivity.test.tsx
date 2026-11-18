// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReasoningTrace, ToolTrace } from './AssistActivity'

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
})
