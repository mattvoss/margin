import { describe, expect, it } from 'vitest'
import { memoryKindForFile, parseMemoryCandidates } from './memory-extraction.server'

describe('file memory extraction', () => {
  it('maps categorized workspace folders to manuscript memory kinds', () => {
    expect(memoryKindForFile('chapters/01.md')).toBe('chapter')
    expect(memoryKindForFile('characters/samantha.md')).toBe('character')
    expect(memoryKindForFile('locations/ballroom.md')).toBe('location')
    expect(memoryKindForFile('styles/samantha-style.md')).toBe('style')
    expect(memoryKindForFile('notes/ideas.md')).toBeNull()
  })

  it('accepts the manuscript-specific memory kinds', () => {
    expect(parseMemoryCandidates(JSON.stringify({ memories: [
      { kind: 'character', content: 'Samantha resists the transformation.' },
      { kind: 'location', content: 'The ballroom has mirrored walls.' },
      { kind: 'invalid', content: 'Ignore this.' },
    ] }))).toEqual([
      { kind: 'character', content: 'Samantha resists the transformation.' },
      { kind: 'location', content: 'The ballroom has mirrored walls.' },
    ])
  })
})
