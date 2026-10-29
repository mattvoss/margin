/**
 * Editor-level checks for reference chips. The extension is view-only, so the
 * important properties are: matching markdown text gets decorated, the chip
 * carries the resolved path, and removing it edits the underlying text.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import type { Editor as EditorType } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import { FileMentionExtension } from './FileMentionExtension'
import { useEditorStore } from '../../stores/editorStore'

// jsdom has no rAF; ProseMirror schedules through it.
if (typeof window !== 'undefined' && !window.requestAnimationFrame) {
  window.requestAnimationFrame = (cb: FrameRequestCallback) =>
    window.setTimeout(cb, 0)
}

const editors: EditorType[] = []

afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
  useEditorStore.setState({ openedFiles: [], currentFilePath: null })
})

function createEditor(markdown: string): EditorType {
  const editor = new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ html: false, tightLists: true }),
      FileMentionExtension,
    ],
    content: '',
  })
  editors.push(editor)
  editor.commands.setContent(markdown)
  return editor
}

describe('FileMentionExtension', () => {
  it('decorates a reference to a workspace file', () => {
    useEditorStore.setState({
      openedFiles: [
        { name: 'notes.md', path: 'notes.md', content: '', originalContent: '' },
      ],
      currentFilePath: 'chapters/chapter-1.md',
    })

    const editor = createEditor('See @notes.md here')
    const chips = editor.view.dom.querySelectorAll('.file-mention')

    expect(chips).toHaveLength(1)
    expect(chips[0]?.getAttribute('data-path')).toBe('notes.md')
    expect(
      editor.view.dom.querySelectorAll('.file-mention__remove'),
    ).toHaveLength(1)
  })

  it('leaves unknown references as plain text', () => {
    const editor = createEditor('See @missing.md here')
    expect(editor.view.dom.querySelectorAll('.file-mention')).toHaveLength(0)
  })

  it('removes the reference through the chip button', () => {
    useEditorStore.setState({
      openedFiles: [
        { name: 'notes.md', path: 'notes.md', content: '', originalContent: '' },
      ],
      currentFilePath: 'chapters/chapter-1.md',
    })

    const editor = createEditor('See @notes.md here')
    const remove = editor.view.dom.querySelector(
      '.file-mention__remove',
    ) as HTMLButtonElement
    remove.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(editor.state.doc.textContent).toBe('See  here')
    expect(editor.view.dom.querySelectorAll('.file-mention')).toHaveLength(0)
  })
})
