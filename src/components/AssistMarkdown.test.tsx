import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AssistMarkdown } from './AssistMarkdown'

describe('AssistMarkdown', () => {
  it('renders common Markdown through Streamdown', () => {
    const html = renderToStaticMarkup(
      <AssistMarkdown>{'# Title\n\n- **bold**\n\n```ts\nconst answer = 42\n```'}</AssistMarkdown>,
    )

    expect(html).toContain('data-streamdown="heading-1"')
    expect(html).toContain('data-streamdown="strong"')
    expect(html).toContain('data-streamdown="code-block"')
    expect(html).toContain('const answer = 42')
  })

  it('does not render raw HTML from assistant output', () => {
    const html = renderToStaticMarkup(
      <AssistMarkdown>{'<script>alert("xss")</script>\n\nSafe text'}</AssistMarkdown>,
    )

    expect(html).not.toContain('<script>')
    expect(html).toContain('Safe text')
  })

  it('accepts incomplete Markdown while content is streaming', () => {
    const html = renderToStaticMarkup(
      <AssistMarkdown streaming>{'**still arriving'}</AssistMarkdown>,
    )

    expect(html).toContain('still arriving')
  })
})
