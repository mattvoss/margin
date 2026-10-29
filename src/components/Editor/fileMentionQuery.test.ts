import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import type { Editor as EditorType } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { computeFileMention, parseMentionQuery } from './fileMentionQuery'

// jsdom has no rAF; ProseMirror schedules through it.
if (typeof window !== 'undefined' && !window.requestAnimationFrame) {
  window.requestAnimationFrame = (cb: FrameRequestCallback) =>
    window.setTimeout(cb, 0)
}

const editors: EditorType[] = []
afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
})

function createEditor(content: string): EditorType {
  const editor = new Editor({
    extensions: [StarterKit],
    content,
  })
  editors.push(editor)
  return editor
}

function caretAtEnd(editor: EditorType) {
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
}

describe('parseMentionQuery', () => {
  it('recognises an empty query right after @', () => {
    expect(parseMentionQuery('Hello @')).toEqual({ query: '', atIndex: 6 })
  })

  it('captures the filename query', () => {
    expect(parseMentionQuery('See @characters/el')).toEqual({
      query: 'characters/el',
      atIndex: 4,
    })
  })

  it('requires a word boundary before @', () => {
    expect(parseMentionQuery('mail me@example')).toBeNull()
  })

  it('allows opening punctuation before @', () => {
    expect(parseMentionQuery('(@ela')).toEqual({ query: 'ela', atIndex: 1 })
  })

  it('stops at whitespace', () => {
    expect(parseMentionQuery('@notes.md and')).toBeNull()
  })
})

describe('computeFileMention', () => {
  it('returns the range of the typed reference', () => {
    const editor = createEditor('<p>See @el</p>')
    caretAtEnd(editor)
    expect(computeFileMention(editor)).toEqual({
      query: 'el',
      range: { from: 5, to: 8 },
    })
  })

  it('ignores non-collapsed selections', () => {
    const editor = createEditor('<p>See @el</p>')
    editor.commands.setTextSelection({ from: 1, to: 8 })
    expect(computeFileMention(editor)).toBeNull()
  })

  it('ignores code blocks', () => {
    const editor = createEditor('<pre><code>@el</code></pre>')
    caretAtEnd(editor)
    expect(computeFileMention(editor)).toBeNull()
  })

  it('ignores an @ inside a word', () => {
    const editor = createEditor('<p>mail me@el</p>')
    caretAtEnd(editor)
    expect(computeFileMention(editor)).toBeNull()
  })
})
