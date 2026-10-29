import { describe, expect, it } from 'vitest'
import {
  buildMentionAliases,
  filterMentionFiles,
  findMentionRanges,
  isReferenceablePath,
  mentionTextFor,
  type ReferenceFile,
} from './fileMentions'

const notes: ReferenceFile = { name: 'notes.md', path: 'notes.md' }
const elara: ReferenceFile = { name: 'elara.md', path: 'characters/elara.md' }
const style: ReferenceFile = { name: 'cinematic.md', path: 'styles/cinematic.md' }
const files = [notes, elara, style]

function aliasesFor(list: ReferenceFile[], currentPath?: string | null) {
  return buildMentionAliases(list, currentPath)
}

describe('buildMentionAliases', () => {
  it('registers a unique basename and the relative path', () => {
    const aliases = aliasesFor(files)
    const names = aliases.map((entry) => entry.alias)
    expect(names).toContain('elara.md')
    expect(names).toContain('characters/elara.md')
    expect(names).toContain('notes.md')
    // Root files have no separate path alias.
    expect(names.filter((name) => name === 'notes.md')).toHaveLength(1)
  })

  it('drops ambiguous basenames in favour of paths', () => {
    const duplicate: ReferenceFile = { name: 'notes.md', path: 'lore/notes.md' }
    const aliases = aliasesFor([notes, duplicate])
    const names = aliases.map((entry) => entry.alias)
    // The root file keeps its path alias (`notes.md`); the folder copy is
    // only reachable through its relative path.
    expect(aliases.find((entry) => entry.alias === 'notes.md')?.target.path).toBe(
      'notes.md',
    )
    expect(names).toContain('lore/notes.md')
  })

  it('excludes prompts, hidden paths, non-markdown and the current file', () => {
    const aliases = aliasesFor([
      ...files,
      { name: 'writer.md', path: 'prompts/writer.md' },
      { name: 'secret.md', path: '.trash/secret.md' },
      { name: 'image.png', path: 'assets/image.png' },
    ], 'characters/elara.md')
    const names = aliases.map((entry) => entry.alias)
    expect(names).not.toContain('writer.md')
    expect(names).not.toContain('secret.md')
    expect(names).not.toContain('image.png')
    expect(names).not.toContain('elara.md')
    expect(names).toContain('notes.md')
  })
})

describe('findMentionRanges', () => {
  it('finds basename and path references, including sentence punctuation', () => {
    const matches = findMentionRanges(
      'See @elara.md, then @characters/elara.md.',
      aliasesFor(files),
    )
    expect(matches.map((match) => match.target.path)).toEqual([
      'characters/elara.md',
      'characters/elara.md',
    ])
    expect(matches.map((match) => match.to - match.from)).toEqual([
      '@elara.md'.length,
      '@characters/elara.md'.length,
    ])
  })

  it('does not match emails or longer filenames', () => {
    expect(findMentionRanges('mail me@notes.md', aliasesFor(files))).toEqual([])
    expect(findMentionRanges('see @notes.md.bak', aliasesFor(files))).toEqual([])
  })

  it('matches next to punctuation and at the start of the text', () => {
    expect(findMentionRanges('(@notes.md)', aliasesFor(files))).toHaveLength(1)
    expect(findMentionRanges('@notes.md', aliasesFor(files))).toHaveLength(1)
  })

  it('keeps adjacent references separate', () => {
    const matches = findMentionRanges(
      '@notes.md @elara.md',
      aliasesFor(files),
    )
    expect(matches.map((match) => match.target.name)).toEqual([
      'notes.md',
      'elara.md',
    ])
  })
})

describe('mentionTextFor', () => {
  it('uses the basename when it is unique', () => {
    expect(mentionTextFor(elara, files)).toBe('@elara.md')
  })

  it('uses the relative path when basenames collide', () => {
    const duplicate: ReferenceFile = { name: 'elara.md', path: 'lore/elara.md' }
    expect(mentionTextFor(elara, [...files, duplicate])).toBe(
      '@characters/elara.md',
    )
  })
})

describe('filterMentionFiles', () => {
  it('ranks basename prefixes above path matches', () => {
    const extra: ReferenceFile = { name: 'notes', path: 'lore/elara-notes.md' }
    const result = filterMentionFiles([...files, extra], 'ela')
    expect(result.map((file) => file.path)).toEqual([
      'characters/elara.md',
      'lore/elara-notes.md',
    ])
  })

  it('excludes the current document and hidden prompts', () => {
    const result = filterMentionFiles(
      [...files, { name: 'writer.md', path: 'prompts/writer.md' }],
      '',
      'notes.md',
    )
    expect(result.map((file) => file.path)).toEqual([
      'characters/elara.md',
      'styles/cinematic.md',
    ])
  })
})

describe('isReferenceablePath', () => {
  it('accepts workspace markdown only', () => {
    expect(isReferenceablePath('characters/elara.md')).toBe(true)
    expect(isReferenceablePath('prompts/writer.md')).toBe(false)
    expect(isReferenceablePath('lore/.draft.md')).toBe(false)
    expect(isReferenceablePath('assets/cat.png')).toBe(false)
  })
})
