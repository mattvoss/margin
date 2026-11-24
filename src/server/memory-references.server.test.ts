import { describe, expect, it } from 'vitest'
import { mentionForPath, sourceContentHash, sourceReferenceFor, validateMentionPath } from './memory-references.server'

describe('memory references', () => {
  it('resolves source text to lines, offsets, and the nearest heading', () => {
    const content = '# Scene\r\n\r\nThe ballroom has mirrored walls.\r\n'
    const reference = sourceReferenceFor('locations/ballroom.md', content, 'The ballroom has mirrored walls.')

    expect(reference.path).toBe('locations/ballroom.md')
    expect(reference.startLine).toBe(3)
    expect(reference.endLine).toBe(3)
    expect(reference.startOffset).toBeGreaterThan(0)
    expect(reference.endOffset).toBeGreaterThan(reference.startOffset!)
    expect(reference.heading).toBe('Scene')
    expect(reference.contentHash).toBe(sourceContentHash(content))
  })

  it('allows only referenceable Markdown paths', () => {
    expect(validateMentionPath('characters/elara.md')).toBe('characters/elara.md')
    expect(() => validateMentionPath('../secrets.md')).toThrow()
    expect(() => validateMentionPath('.hidden.md')).toThrow()
    expect(() => validateMentionPath('outputs/result.md')).toThrow()
  })

  it('creates display metadata for a related mention', () => {
    expect(mentionForPath('locations/ballroom.md')).toEqual({
      path: 'locations/ballroom.md',
      name: 'ballroom.md',
      managedBy: 'user',
    })
  })
})
