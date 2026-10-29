import { describe, expect, it } from 'vitest'
import { restorePromptMentions, splitPromptMentions, type MentionTarget } from './promptMentions'

const notes: MentionTarget = { name: 'notes.md', path: 'drafts/notes.md' }
const characters: MentionTarget = { name: 'characters.md', path: 'world/characters.md' }

function texts(text: string, targets: MentionTarget[] = []) {
  return splitPromptMentions(text, targets).filter(s => s.type === 'text')
}

describe('splitPromptMentions', () => {
  it('returns plain text unchanged (trimmed)', () => {
    expect(splitPromptMentions('  tighten this paragraph  ', [])).toEqual([
      { type: 'text', value: 'tighten this paragraph' },
    ])
  })

  it('revives a known mention as a chip target', () => {
    expect(splitPromptMentions('rewrite @notes.md please', [notes])).toEqual([
      { type: 'text', value: 'rewrite ' },
      { type: 'mention', target: notes },
      { type: 'text', value: ' please' },
    ])
  })

  it('leaves unknown mentions as text', () => {
    const segments = splitPromptMentions('rewrite @missing.md please', [notes])
    expect(segments).toEqual([{ type: 'text', value: 'rewrite @missing.md please' }])
  })

  it('handles filenames with spaces and regex characters', () => {
    const draft: MentionTarget = { name: 'draft (1).md', path: 'draft (1).md' }
    expect(splitPromptMentions('use @draft (1).md here', [draft])).toEqual([
      { type: 'text', value: 'use ' },
      { type: 'mention', target: draft },
      { type: 'text', value: ' here' },
    ])
  })

  it('does not match a longer filename by prefix', () => {
    expect(texts('use @notes.md.bak here', [notes])).toEqual([
      { type: 'text', value: 'use @notes.md.bak here' },
    ])
  })

  it('matches mentions before sentence punctuation', () => {
    expect(splitPromptMentions('rewrite @notes.md.', [notes])).toEqual([
      { type: 'text', value: 'rewrite ' },
      { type: 'mention', target: notes },
      { type: 'text', value: '.' },
    ])
    expect(splitPromptMentions('read @notes.md, then stop', [notes])).toEqual([
      { type: 'text', value: 'read ' },
      { type: 'mention', target: notes },
      { type: 'text', value: ', then stop' },
    ])
  })

  it('prefers the longest matching name', () => {
    const short: MentionTarget = { name: 'notes', path: 'notes' }
    expect(
      splitPromptMentions('@notes.md', [short, notes]),
    ).toEqual([{ type: 'mention', target: notes }])
  })

  it('does not treat emails as mentions', () => {
    const domain: MentionTarget = { name: 'example.com', path: 'example.com' }
    expect(texts('mail me@example.com now', [domain])).toEqual([
      { type: 'text', value: 'mail me@example.com now' },
    ])
  })

  it('matches mentions next to punctuation', () => {
    expect(splitPromptMentions('(@notes.md)', [notes])).toEqual([
      { type: 'text', value: '(' },
      { type: 'mention', target: notes },
      { type: 'text', value: ')' },
    ])
  })

  it('drops selection tokens without leaving double spaces', () => {
    expect(splitPromptMentions('@selection(1,234 ch) rewrite this', [])).toEqual([
      { type: 'text', value: 'rewrite this' },
    ])
    expect(splitPromptMentions('rewrite @selection(5 ch) this', [])).toEqual([
      { type: 'text', value: 'rewrite this' },
    ])
  })

  it('keeps both chips when mentions are adjacent', () => {
    expect(
      splitPromptMentions('@notes.md @characters.md', [notes, characters]),
    ).toEqual([
      { type: 'mention', target: notes },
      { type: 'text', value: ' ' },
      { type: 'mention', target: characters },
    ])
  })

  it('resolves duplicate names to the first target', () => {
    const first: MentionTarget = { name: 'notes.md', path: 'first/notes.md' }
    const second: MentionTarget = { name: 'notes.md', path: 'second/notes.md' }
    expect(splitPromptMentions('@notes.md', [first, second])).toEqual([
      { type: 'mention', target: first },
    ])
  })

  it('ignores targets missing a name or path', () => {
    expect(
      splitPromptMentions('@notes.md', [{ name: 'notes.md', path: '' }]),
    ).toEqual([{ type: 'text', value: '@notes.md' }])
  })
})

describe('restorePromptMentions', () => {
  const intro: MentionTarget = { name: 'intro.md', path: 'drafts/intro.md' }

  it('passes plain text through when nothing was attached', () => {
    expect(restorePromptMentions('  tighten this  ', [])).toEqual([
      { type: 'text', value: 'tighten this' },
    ])
  })

  it('prepends refs that are missing from the prompt text', () => {
    expect(restorePromptMentions('tighten this', [notes])).toEqual([
      { type: 'mention', target: notes },
      { type: 'text', value: ' tighten this' },
    ])
  })

  it('keeps a ref that already appears in the text exactly once, in place', () => {
    expect(restorePromptMentions('rewrite @notes.md please', [notes])).toEqual([
      { type: 'text', value: 'rewrite ' },
      { type: 'mention', target: notes },
      { type: 'text', value: ' please' },
    ])
  })

  it('prepends only the refs missing from a partially tagged prompt', () => {
    expect(
      restorePromptMentions('rewrite @notes.md please', [intro, notes]),
    ).toEqual([
      { type: 'mention', target: intro },
      { type: 'text', value: ' rewrite ' },
      { type: 'mention', target: notes },
      { type: 'text', value: ' please' },
    ])
  })

  it('prefers the attached path over a workspace file with the same name', () => {
    const workspaceNotes: MentionTarget = { name: 'notes.md', path: 'other/notes.md' }
    expect(
      restorePromptMentions('@notes.md', [notes], [workspaceNotes]),
    ).toEqual([{ type: 'mention', target: notes }])
  })

  it('resolves text mentions from workspace files even when not attached', () => {
    expect(restorePromptMentions('@intro.md', [], [intro])).toEqual([
      { type: 'mention', target: intro },
    ])
  })

  it('dedupes attached refs and ignores malformed entries', () => {
    expect(
      restorePromptMentions('', [notes, notes, { name: 'notes.md', path: '' }]),
    ).toEqual([{ type: 'mention', target: notes }])
  })

  it('still drops selection tokens while keeping attached refs', () => {
    expect(
      restorePromptMentions('@selection(1,234 ch) rewrite @notes.md', [notes, intro]),
    ).toEqual([
      { type: 'mention', target: intro },
      { type: 'text', value: ' rewrite ' },
      { type: 'mention', target: notes },
    ])
  })
})
