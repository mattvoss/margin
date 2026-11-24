import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore } from '../../stores/editorStore'
import { mentionTextFor, type ReferenceFile } from '../../lib/fileMentions'
import { FileMentionMenu } from './FileMentionMenu'
import type { FileMentionMenuHandle } from './FileMentionMenu'
import { computeFileMention } from './fileMentionQuery'
import { FileMentionExtension } from './FileMentionExtension'
import { useCursorMenuPosition } from './useCursorMenuPosition'

interface SuggestionState {
  query: string
  range: { from: number; to: number }
}

interface MarkdownMentionEditorProps {
  value: string
  onChange: (value: string) => void
  label: string
}

const FORMAT_BUTTONS: Array<{
  label: string
  title: string
  command: (editor: Editor) => void
}> = [
  { label: 'B', title: 'Bold', command: (editor) => editor.chain().focus().toggleBold().run() },
  { label: 'I', title: 'Italic', command: (editor) => editor.chain().focus().toggleItalic().run() },
  { label: 'S', title: 'Strikethrough', command: (editor) => editor.chain().focus().toggleStrike().run() },
  { label: '• List', title: 'Bullet list', command: (editor) => editor.chain().focus().toggleBulletList().run() },
  { label: '1. List', title: 'Numbered list', command: (editor) => editor.chain().focus().toggleOrderedList().run() },
]

export function MarkdownMentionEditor({
  value,
  onChange,
  label,
}: MarkdownMentionEditorProps) {
  const openedFiles = useEditorStore((state) => state.openedFiles)
  const currentFilePath = useEditorStore((state) => state.currentFilePath)
  const mentionRef = useRef<FileMentionMenuHandle | null>(null)
  const mentionElRef = useRef<HTMLDivElement | null>(null)
  const lastValueRef = useRef(value)
  const [fileMention, setFileMention] = useState<SuggestionState | null>(null)

  const refreshFileMention = (editor: Editor) => {
    const found = computeFileMention(editor)
    setFileMention((previous) => {
      if (!found) return previous === null ? previous : null
      if (
        previous?.query === found.query &&
        previous.range.from === found.range.from &&
        previous.range.to === found.range.to
      ) {
        return previous
      }
      return found
    })
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown.configure({ html: false, tightLists: true }),
      FileMentionExtension.configure({ excludeCurrentFile: false }),
    ],
    content: value || '',
    editorProps: {
      attributes: {
        'aria-label': label,
        class: 'ProseMirror min-h-[84px] max-h-[220px] overflow-y-auto px-2.5 py-2 text-[12px] leading-relaxed text-[var(--text)] focus:outline-none prose prose-sm max-w-none',
      },
      handleKeyDown: (_view, event) => mentionRef.current?.onKeyDown(event) ?? false,
    },
    onUpdate: ({ editor }) => {
      const storage = editor.storage as { markdown?: { getMarkdown: () => string } }
      const markdown = storage.markdown?.getMarkdown().trim() ?? ''
      lastValueRef.current = markdown
      onChange(markdown)
      refreshFileMention(editor)
    },
    onSelectionUpdate: ({ editor }) => refreshFileMention(editor),
  })

  useEffect(() => {
    if (!editor || value === lastValueRef.current) return
    lastValueRef.current = value
    editor.commands.setContent(value || '')
  }, [editor, value])

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.view.dispatch(editor.state.tr.setMeta('fileMentionRefresh', true))
  }, [editor, openedFiles, currentFilePath])

  useEffect(() => {
    if (!editor) return
    const dismiss = () => setFileMention(null)
    editor.on('blur', dismiss)
    return () => editor.off('blur', dismiss)
  }, [editor])

  useCursorMenuPosition(editor, fileMention?.range ?? null, mentionElRef)

  const selectFileMention = (file: ReferenceFile) => {
    if (!editor || !fileMention) return
    const mention = `${mentionTextFor(file, openedFiles, null)} `
    editor.view.dispatch(
      editor.state.tr.insertText(mention, fileMention.range.from, fileMention.range.to),
    )
    setFileMention(null)
    editor.commands.focus()
  }

  const cancelFileMention = () => {
    if (editor && fileMention) {
      editor.chain().focus().deleteRange(fileMention.range).run()
    }
    setFileMention(null)
  }

  return (
    <div className="overflow-hidden rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-input)] focus-within:border-[var(--text-secondary)]">
      <div className="flex items-center gap-0.5 border-b border-[var(--border-subtle)] px-1.5 py-1">
        {FORMAT_BUTTONS.map((button) => (
          <button
            key={button.title}
            type="button"
            title={button.title}
            aria-label={button.title}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor && button.command(editor)}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-heading)]"
          >
            {button.label}
          </button>
        ))}
      </div>
      <div className="relative">
        {editor && !value.trim() && (
          <span className="pointer-events-none absolute left-2.5 top-2 text-[12px] text-[var(--text-muted)]">
            Describe the current situation. Type @ to reference a workspace file.
          </span>
        )}
        <EditorContent editor={editor} />
      </div>
      {editor && fileMention && createPortal(
        <div ref={mentionElRef} className="fixed left-0 top-0 z-[10001]">
          <FileMentionMenu
            ref={mentionRef}
            query={fileMention.query}
            range={fileMention.range}
            files={openedFiles}
            currentPath={null}
            onSelect={selectFileMention}
            onCancel={cancelFileMention}
          />
        </div>,
        document.body,
      )}
    </div>
  )
}
