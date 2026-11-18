// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { splitThinkingTags, ThinkingTagFilter } from './thinking-filter.server'

describe('ThinkingTagFilter', () => {
  it('passes text through when thinking capture is disabled', () => {
    expect(splitThinkingTags('a<think>hidden</think>b', false)).toEqual({
      text: 'a<think>hidden</think>b',
      thinking: '',
    })
  })

  it('captures default thinking tags split across streamed chunks', () => {
    const filter = new ThinkingTagFilter(true)
    const chunks = [
      filter.push('Visible <thi'),
      filter.push('nk>private reasoning</thi'),
      filter.push('nk> answer'),
      filter.flush(),
    ]
    expect(chunks.map((chunk) => chunk.text).join('')).toBe('Visible  answer')
    expect(chunks.map((chunk) => chunk.thinking).join('')).toBe('private reasoning')
  })

  it('captures custom tags and keeps an unclosed block out of visible text', () => {
    expect(splitThinkingTags('before[reason]internal', true, ['[reason]'], ['[/reason]'])).toEqual({
      text: 'before',
      thinking: 'internal',
    })
  })
})
