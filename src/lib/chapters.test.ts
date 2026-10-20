import { describe, expect, it } from 'vitest'
import {
  SAMPLE_WORKSPACE_KEY,
  chapterDisplayName,
  isChapterPath,
  resolveRescanTarget,
  workspaceStorageKey,
} from './chapters'

describe('isChapterPath', () => {
  it('accepts manuscript markdown in a chapter folder or at the root', () => {
    expect(isChapterPath('chapters/01-the-road.md')).toBe(true)
    expect(isChapterPath('book/Chapter 2.md')).toBe(true)
    expect(isChapterPath('prologue.md')).toBe(true)
  })

  it('rejects support files and folder manifests', () => {
    expect(isChapterPath('characters/Elara.md')).toBe(false)
    expect(isChapterPath('characters/ACTIVE_CHARACTERS.json')).toBe(false)
    expect(isChapterPath('styles/style.md')).toBe(false)
    expect(isChapterPath('lore/LORE.md')).toBe(false)
    expect(isChapterPath('prompts/character-tracker.md')).toBe(false)
    expect(isChapterPath('chapters/CHAPTERS.md')).toBe(false)
    expect(isChapterPath('README.md')).toBe(false)
  })

  it('rejects non-markdown and hidden paths', () => {
    expect(isChapterPath(null)).toBe(false)
    expect(isChapterPath('chapters/cover.png')).toBe(false)
    expect(isChapterPath('.trash/chapter.md')).toBe(false)
  })
})

describe('resolveRescanTarget', () => {
  it('prefers the last focused chapter, then the open chapter, then the scan source', () => {
    expect(
      resolveRescanTarget('chapters/03.md', 'chapters/04.md', 'chapters/02.md'),
    ).toBe('chapters/03.md')
    expect(resolveRescanTarget(null, 'chapters/04.md', 'chapters/02.md')).toBe(
      'chapters/04.md',
    )
    expect(resolveRescanTarget(null, 'characters/Elara.md', 'chapters/02.md')).toBe(
      'chapters/02.md',
    )
    expect(resolveRescanTarget(null, null, null)).toBe(null)
  })
})

describe('workspace helpers', () => {
  it('keys the sample workspace separately and keeps chapter names readable', () => {
    expect(workspaceStorageKey(null)).toBe(SAMPLE_WORKSPACE_KEY)
    expect(workspaceStorageKey('  ')).toBe(SAMPLE_WORKSPACE_KEY)
    expect(workspaceStorageKey('/home/writer/book')).toBe('/home/writer/book')
    expect(chapterDisplayName('chapters/01-the-road.md')).toBe('01-the-road.md')
  })
})
