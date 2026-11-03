// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MENTION_MAX_DEPTH,
  DEFAULT_MENTION_MAX_FILES,
  expandMentionedFiles,
  mentionPathsInText,
} from './mentions.server'
import type { ReferenceFile } from '../lib/fileMentions'

const files: ReferenceFile[] = [
  { name: 'chapter-1.md', path: 'chapters/chapter-1.md' },
  { name: 'chapter-2.md', path: 'chapters/chapter-2.md' },
  { name: 'elara.md', path: 'characters/elara.md' },
  { name: 'river.md', path: 'locations/river.md' },
  { name: 'notes.md', path: 'notes.md' },
  { name: 'notes.md', path: 'lore/notes.md' },
  { name: 'maps.md', path: 'lore/maps.md' },
  { name: 'writer.md', path: 'prompts/writer.md' },
  { name: 'draft.md', path: '.trash/draft.md' },
  { name: 'map.png', path: 'assets/map.png' },
]

function reader(contents: Record<string, string>) {
  return async (path: string) => contents[path] ?? null
}

describe('mentionPathsInText', () => {
  it('resolves unique basenames and relative paths', () => {
    expect(
      mentionPathsInText(
        'See @elara.md and @locations/river.md.',
        files,
        'chapters/chapter-1.md',
      ),
    ).toEqual(['characters/elara.md', 'locations/river.md'])
  })

  it('keeps a root file reachable through its path when basenames collide', () => {
    expect(mentionPathsInText('See @notes.md', files)).toEqual(['notes.md'])
    expect(mentionPathsInText('See @lore/notes.md', files)).toEqual([
      'lore/notes.md',
    ])
  })

  it('ignores emails, longer filenames, hidden paths, prompts and non-markdown', () => {
    expect(
      mentionPathsInText(
        'mail me@elara.md and @elara.md.bak and @writer.md @draft.md @map.png',
        files,
      ),
    ).toEqual([])
  })
})

describe('expandMentionedFiles', () => {
  it('keeps explicit roots and follows mentions recursively', async () => {
    const readFile = reader({
      'chapters/chapter-1.md': 'Elara is at @characters/elara.md.',
      'characters/elara.md': 'She lives near @river.md and @chapter-2.md.',
      'locations/river.md': 'A river.',
      'chapters/chapter-2.md': 'Chapter two.',
    })

    const result = await expandMentionedFiles({
      roots: ['chapters/chapter-1.md'],
      availableFiles: files,
      readFile,
    })

    expect(result).toEqual([
      'chapters/chapter-1.md',
      'chapters/chapter-2.md',
      'characters/elara.md',
      'locations/river.md',
    ])
  })

  it('adds resolvable mentions typed directly into the prompt', async () => {
    const readFile = reader({
      'characters/elara.md': 'Elara mentions @locations/river.md.',
      'locations/river.md': 'A river.',
    })

    const result = await expandMentionedFiles({
      text: 'Rewrite the scene with @elara.md.',
      availableFiles: files,
      readFile,
    })

    expect(result).toEqual(['characters/elara.md', 'locations/river.md'])
  })

  it('dedupes cycles and repeated references', async () => {
    const readFile = reader({
      'chapters/chapter-1.md': '@characters/elara.md and @characters/elara.md',
      'characters/elara.md': '@chapters/chapter-1.md',
    })

    const result = await expandMentionedFiles({
      roots: ['chapters/chapter-1.md'],
      availableFiles: files,
      readFile,
    })

    expect(result).toEqual(['chapters/chapter-1.md', 'characters/elara.md'])
  })

  it('keeps missing roots but skips missing children', async () => {
    const readFile = reader({
      'chapters/chapter-1.md': '@characters/missing.md and @characters/elara.md',
      'characters/elara.md': 'Elara.',
    })

    const result = await expandMentionedFiles({
      roots: ['chapters/gone.md', 'chapters/chapter-1.md'],
      availableFiles: files,
      readFile,
    })

    expect(result).toEqual(['chapters/chapter-1.md', 'chapters/gone.md', 'characters/elara.md'])
  })

  it('skips files blocked by a folder manifest', async () => {
    const readFile = reader({
      'chapters/chapter-1.md': '@characters/elara.md and @lore/maps.md',
      'characters/elara.md': 'Elara.',
      'lore/maps.md': 'Maps.',
    })

    const result = await expandMentionedFiles({
      roots: ['chapters/chapter-1.md'],
      availableFiles: files,
      readFile,
      ignoredRefFiles: ['lore/LORE.md'],
    })

    expect(result).toEqual(['chapters/chapter-1.md', 'characters/elara.md'])
  })

  it('never follows hidden, prompt, or non-markdown references', async () => {
    const readFile = reader({
      'chapters/chapter-1.md': '@writer.md @draft.md @map.png @characters/elara.md',
      'characters/elara.md': 'Elara.',
    })

    const result = await expandMentionedFiles({
      roots: ['chapters/chapter-1.md'],
      availableFiles: files,
      readFile,
    })

    expect(result).toEqual(['chapters/chapter-1.md', 'characters/elara.md'])
  })

  it('respects the depth cap', async () => {
    const readFile = reader({
      'a.md': '@b.md',
      'b.md': '@c.md',
      'c.md': '@d.md',
    })
    const chain: ReferenceFile[] = ['a', 'b', 'c', 'd'].map((name) => ({
      name: `${name}.md`,
      path: `${name}.md`,
    }))

    const result = await expandMentionedFiles({
      roots: ['a.md'],
      availableFiles: chain,
      readFile,
      maxDepth: 2,
    })

    // a (0) → b (1) → c (2); c is not scanned, so d is never added.
    expect(result).toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('respects the file cap', async () => {
    const readFile = reader({
      'a.md': '@b.md @c.md @d.md',
      'b.md': '',
      'c.md': '',
      'd.md': '',
    })
    const chain: ReferenceFile[] = ['a', 'b', 'c', 'd'].map((name) => ({
      name: `${name}.md`,
      path: `${name}.md`,
    }))

    const result = await expandMentionedFiles({
      roots: ['a.md'],
      availableFiles: chain,
      readFile,
      maxFiles: 2,
    })

    expect(result).toEqual(['a.md', 'b.md'])
  })

  it('exposes safe defaults', () => {
    expect(DEFAULT_MENTION_MAX_DEPTH).toBe(5)
    expect(DEFAULT_MENTION_MAX_FILES).toBe(40)
  })
})
