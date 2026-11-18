import { describe, expect, it } from 'vitest'
import { parseMemoryCandidates } from './memory-extraction.server'

describe('memory extraction', () => {
  it('accepts only valid, bounded memory candidates', () => {
    expect(parseMemoryCandidates(JSON.stringify({
      memories: [
        { kind: 'preference', content: 'The user prefers concise answers.' },
        { kind: 'unknown', content: 'discard me' },
        { kind: 'fact', content: 'x'.repeat(5000) },
      ],
    }))).toEqual([
      { kind: 'preference', content: 'The user prefers concise answers.' },
    ])
  })

  it('extracts JSON embedded in a model response and rejects malformed output', () => {
    expect(parseMemoryCandidates('Here is the result:\n{"memories":[{"kind":"fact","content":"The user writes fiction."}]}'))
      .toEqual([{ kind: 'fact', content: 'The user writes fiction.' }])
    expect(parseMemoryCandidates('not json')).toEqual([])
  })
})
