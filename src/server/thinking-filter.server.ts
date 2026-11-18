const DEFAULT_OPENING_TAGS = ['<|channel|>', '<think>']
const DEFAULT_CLOSING_TAGS = [
  '<channel|>',
  '<|channel|>',
  '</channel|>',
  '|channel|>',
  '</think>',
]

export interface ThinkingFilterResult {
  text: string
  thinking: string
}

/** Diverts configured reasoning blocks while preserving partial tags in streams. */
export class ThinkingTagFilter {
  private readonly openings: string[]
  private readonly closings: string[]
  private readonly maxTagLength: number
  private readonly enabled: boolean
  private pending = ''
  private thinkingBuffer = ''
  private inThinking = false

  constructor(
    enabled: boolean,
    customOpeningTags: string[] = [],
    customClosingTags: string[] = [],
  ) {
    this.enabled = enabled
    this.openings = [...DEFAULT_OPENING_TAGS, ...customOpeningTags].filter(Boolean)
    this.closings = [...DEFAULT_CLOSING_TAGS, ...customClosingTags].filter(Boolean)
    this.maxTagLength = Math.max(12, ...this.openings.map((tag) => tag.length))
  }

  push(content: string): ThinkingFilterResult {
    if (!this.enabled || !content) return { text: content, thinking: '' }
    let text = ''
    let thinking = ''
    let remaining = content

    for (;;) {
      if (this.inThinking) {
        this.thinkingBuffer += remaining
        const close = this.findTag(this.thinkingBuffer, this.closings)
        if (close) {
          thinking += this.thinkingBuffer.slice(0, close.index)
          remaining = this.thinkingBuffer.slice(close.index + close.tag.length)
          this.thinkingBuffer = ''
          this.inThinking = false
          continue
        }
        if (this.thinkingBuffer.length > 6000) {
          thinking += this.thinkingBuffer
          this.thinkingBuffer = ''
          this.inThinking = false
        }
        break
      }

      this.pending += remaining
      remaining = ''
      const open = this.findTag(this.pending, this.openings)
      if (open) {
        text += this.pending.slice(0, open.index)
        this.thinkingBuffer = this.pending.slice(open.index + open.tag.length)
        this.pending = ''
        this.inThinking = true
        continue
      }

      if (this.pending.length > this.maxTagLength) {
        const safeLength = this.pending.length - this.maxTagLength
        text += this.pending.slice(0, safeLength)
        this.pending = this.pending.slice(safeLength)
      }
      break
    }

    return { text, thinking }
  }

  flush(): ThinkingFilterResult {
    if (!this.enabled) return { text: '', thinking: '' }
    const text = this.inThinking ? '' : this.pending
    const thinking = this.thinkingBuffer
    this.pending = ''
    this.thinkingBuffer = ''
    this.inThinking = false
    return { text, thinking }
  }

  private findTag(
    value: string,
    tags: string[],
  ): { index: number; tag: string } | null {
    let match: { index: number; tag: string } | null = null
    for (const tag of tags) {
      const index = value.indexOf(tag)
      if (
        index !== -1 &&
        (!match || index < match.index || (index === match.index && tag.length > match.tag.length))
      ) {
        match = { index, tag }
      }
    }
    return match
  }
}

export function splitThinkingTags(
  content: string,
  enabled: boolean,
  customOpeningTags: string[] = [],
  customClosingTags: string[] = [],
): ThinkingFilterResult {
  const filter = new ThinkingTagFilter(enabled, customOpeningTags, customClosingTags)
  const first = filter.push(content)
  const last = filter.flush()
  return {
    text: first.text + last.text,
    thinking: first.thinking + last.thinking,
  }
}
