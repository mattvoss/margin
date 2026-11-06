import { Streamdown } from 'streamdown'

interface AssistMarkdownProps {
  children: string
  streaming?: boolean
  className?: string
}

/**
 * Markdown boundary for assistant output.
 * Streamdown's default sanitization remains enabled; raw HTML is disabled so
 * model output cannot inject arbitrary markup into the assistant panel.
 * Source: https://streamdown.ai/docs/configuration
 */
export function AssistMarkdown({ children, streaming = false, className }: AssistMarkdownProps) {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      parseIncompleteMarkdown={streaming}
      skipHtml
      className={className}
    >
      {children}
    </Streamdown>
  )
}
