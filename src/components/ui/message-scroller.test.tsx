// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageScrollerContent, MessageScrollerItem } from './message-scroller'

describe('MessageScroller AI chat semantics', () => {
  it('exposes a live log and stable turn-anchor metadata', () => {
    const markup = renderToStaticMarkup(
      <MessageScrollerContent>
        <MessageScrollerItem messageId="turn-1:user" scrollAnchor>
          <p>Question</p>
        </MessageScrollerItem>
        <MessageScrollerItem messageId="turn-1:assistant">
          <p>Answer</p>
        </MessageScrollerItem>
      </MessageScrollerContent>,
    )

    expect(markup).toContain('role="log"')
    expect(markup).toContain('aria-relevant="additions"')
    expect(markup).toContain('data-message-id="turn-1:user"')
    expect(markup).toContain('data-scroll-anchor="true"')
    expect(markup).toContain('data-message-id="turn-1:assistant"')
    expect(markup).toContain('Question')
    expect(markup).toContain('Answer')
  })
})
