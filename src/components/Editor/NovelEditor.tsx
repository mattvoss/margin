import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { createPortal } from 'react-dom'
import StarterKit from '@tiptap/starter-kit'
import { useEditorStore } from '../../stores/editorStore'
import { useEffect, useRef, useState } from 'react'
import { Markdown } from 'tiptap-markdown'
import { WritingBubbleMenu } from './WritingBubbleMenu'
import { MarginImage } from './MarginImageExtension'
import { ImageGenerateDialogHost } from './ImageGenerateDialog'
import { SlashMenuView } from './SlashMenu'
import { computeSlash } from './slashQuery'
import type { SlashMenuHandle } from './SlashMenu'
import { FileMentionMenu } from './FileMentionMenu'
import type { FileMentionMenuHandle } from './FileMentionMenu'
import { computeFileMention } from './fileMentionQuery'
import { FileMentionExtension } from './FileMentionExtension'
import { useCursorMenuPosition } from './useCursorMenuPosition'
import { mentionTextFor, type ReferenceFile } from '../../lib/fileMentions'
import { AiDiffHighlightExtension } from './AiDiffHighlightExtension'
import { reapplyHarnessHighlight } from '../../lib/applyHarnessResult'
import {
  importImageFromUrl,
  insertStoredImage,
  insertStoredImageAt,
  isBareImageUrl,
  isImageFile,
  uploadImageFile,
} from '../../lib/media'
import { EditorState } from '@tiptap/pm/state'
import { toast } from '../../stores/toastStore'

interface SuggestionState {
  query: string
  range: { from: number; to: number }
}

// Upload pasted/dropped image files, inserting each stored asset in turn.
async function handleImageFiles(editor: Editor, files: File[]): Promise<void> {
  for (const file of files) {
    try {
      const path = await uploadImageFile(file)
      insertStoredImage(editor, path, file.name.replace(/\.[^.]+$/, ''))
    } catch (err) {
      toast.error(`Image upload failed: ${err instanceof Error ? err.message : err}`)
    }
  }
}

// A bare image URL pasted on its own keeps its pasted text while the image
// is downloaded into workspace/assets/ and inserted below. The download is
// async, so the caller passes the pre-paste selection as the anchor —
// `handlePaste` runs before the native paste transaction, so the live
// selection is still the paste point. No position tracking: if the user
// typed meanwhile the image may land slightly off, which is acceptable.
//
// File-switch guard: the originating document is identified by
// `currentFilePath`. If it changed mid-download, the asset is still stored
// but the insert is dropped — never into the wrong document.
async function handleBareImageUrl(
  editor: Editor,
  url: string,
  anchor: number,
): Promise<void> {
  const pastedUrl = url.trim()
  const fileAtPaste = useEditorStore.getState().currentFilePath
  const path = await importImageFromUrl(pastedUrl).catch((err) => {
    // Quiet for users (their pasted text is already in the doc), traceable.
    console.warn(`Margin: image download failed for ${pastedUrl}:`, err)
    return null
  })
  if (path == null) return
  if (editor.isDestroyed) return
  if (useEditorStore.getState().currentFilePath !== fileAtPaste) {
    console.warn('Margin: paste target file changed mid-download — dropping image')
    return
  }
  insertStoredImageAt(editor, anchor, path)
}

export function NovelEditor({ showInlinePopup = true }: { showInlinePopup?: boolean }) {
  const content = useEditorStore(state => state.content)
  const setContent = useEditorStore(state => state.setContent)
  const setEditor = useEditorStore(state => state.setEditor)
  const setSelectedText = useEditorStore(state => state.setSelectedText)
  const setSelectionRange = useEditorStore(state => state.setSelectionRange)
  const setAnchorPosition = useEditorStore(state => state.setAnchorPosition)
  const aiPendingEdit = useEditorStore(state => state.aiPendingEdit)
  const setAiPendingEdit = useEditorStore(state => state.setAiPendingEdit)
  const openedFiles = useEditorStore(state => state.openedFiles)
  const currentFilePath = useEditorStore(state => state.currentFilePath)
  const lastContentRef = useRef('')
  // Flag: true while we are programmatically calling setContent so onUpdate
  // doesn't echo the change back into Zustand and cause an infinite loop.
  const isProgrammaticUpdateRef = useRef(false)
  const editorRef = useRef<Editor | null>(null)
  const slashRef = useRef<SlashMenuHandle>(null)
  const [slash, setSlash] = useState<SuggestionState | null>(null)
  const slashElRef = useRef<HTMLDivElement | null>(null)
  const mentionRef = useRef<FileMentionMenuHandle>(null)
  const [fileMention, setFileMention] = useState<SuggestionState | null>(null)
  const mentionElRef = useRef<HTMLDivElement | null>(null)

  const refreshSlash = (editor: Editor) => {
    const found = computeSlash(editor)
    if (!found) {
      setSlash((prev) => (prev === null ? prev : null))
      return
    }
    setSlash((prev) => {
      if (
        prev &&
        prev.query === found.query &&
        prev.range.from === found.range.from &&
        prev.range.to === found.range.to
      ) {
        return prev
      }
      return found
    })
  }

  const refreshFileMention = (editor: Editor) => {
    const found = computeFileMention(editor)
    if (!found) {
      setFileMention((prev) => (prev === null ? prev : null))
      return
    }
    setFileMention((prev) => {
      if (
        prev &&
        prev.query === found.query &&
        prev.range.from === found.range.from &&
        prev.range.to === found.range.to
      ) {
        return prev
      }
      return found
    })
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Plain clicks open the link in a new tab (never a redirect away
        // from the editor). The click handler lives in the Link extension —
        // no editor-level override.
        link: {
          openOnClick: true,
          HTMLAttributes: {
            target: '_blank',
            rel: 'noopener noreferrer',
          },
        },
      }),
      MarginImage,
      Markdown.configure({ html: false, tightLists: true }),
      AiDiffHighlightExtension,
      FileMentionExtension,
    ],
    // Feed raw markdown — the Markdown extension parses it natively
    content: content || '',
    onUpdate: ({ editor }) => {
      // Only propagate changes that come from the USER typing, not from us.
      if (isProgrammaticUpdateRef.current) return

      // Auto-accept AI edits if the user types
      if (aiPendingEdit) {
        setAiPendingEdit(null)
        isProgrammaticUpdateRef.current = true
        editor.commands.clearAiHighlight()
        isProgrammaticUpdateRef.current = false
      }
      const markdownStorage = editor.storage as { markdown?: { getMarkdown: () => string } }
      const newMarkdown = markdownStorage.markdown?.getMarkdown()
      if (newMarkdown) {
        lastContentRef.current = newMarkdown
        setContent(newMarkdown)
      }
      refreshSlash(editor)
      refreshFileMention(editor)
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to, empty } = editor.state.selection
      setAnchorPosition(from)
      if (empty) {
        setSelectedText('')
        setSelectionRange(null)
      } else {
        const text = editor.state.doc.textBetween(from, to, ' ')
        setSelectedText(text)
        setSelectionRange({ from, to })
      }
      refreshSlash(editor)
      refreshFileMention(editor)
    },
    editorProps: {
      attributes: {
        class: 'prose prose-slate relative max-w-none focus:outline-none min-h-[500px] px-8 py-6',
      },
      handleKeyDown: (_view, event) => {
        if (mentionRef.current?.onKeyDown(event)) return true
        if (slashRef.current?.onKeyDown(event)) return true
        return false
      },
      handlePaste: (_view, event) => {
        const editor = editorRef.current
        if (!editor) return false
        const files = Array.from(event.clipboardData?.files ?? []).filter(isImageFile)
        if (files.length > 0) {
          event.preventDefault()
          void handleImageFiles(editor, files)
          return true
        }
        const text = event.clipboardData?.getData('text/plain') ?? ''
        if (isBareImageUrl(text)) {
          // Let the native paste land the URL text; the image follows below
          // once downloaded. Anchor is the pre-paste selection (this handler
          // runs before the native paste transaction is dispatched).
          void handleBareImageUrl(editor, text, editor.state.selection.to)
          return false
        }
        return false
      },
      handleDrop: (_view, event) => {
        const editor = editorRef.current
        if (!editor) return false
        const files = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile)
        if (files.length === 0) return false
        event.preventDefault()
        void handleImageFiles(editor, files)
        return true
      },
    },
  })

  useEffect(() => {
    if (editor) {
      setEditor(editor)
      editorRef.current = editor
    }
  }, [editor, setEditor])

  // Chips are view-only decorations computed from the store. When the
  // workspace file list arrives (or changes), an empty transaction forces a
  // fresh decoration pass so existing `@name` text lights up without an edit.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.view.dispatch(editor.state.tr.setMeta('fileMentionRefresh', true))
  }, [editor, openedFiles, currentFilePath])

  // Clicking outside the editor (sidebar, assistant) closes both menus.
  useEffect(() => {
    if (!editor) return
    const dismiss = () => {
      setSlash(null)
      setFileMention(null)
    }
    editor.on('blur', dismiss)
    return () => {
      editor.off('blur', dismiss)
    }
  }, [editor])

  // Sync external content changes (e.g. doc switch, streaming) into the editor.
  // Pass raw markdown — tiptap-markdown parses it, no html intermediary needed.
  useEffect(() => {
    if (editor && content !== undefined) {
      if (content !== lastContentRef.current) {
        lastContentRef.current = content
        setSlash(null)
        setFileMention(null)
        isProgrammaticUpdateRef.current = true
        editor.commands.setContent(content || '')
        // prosemirror-history does not export clearHistory.
        // Rebuild a fresh EditorState with the same doc + plugins so every
        // plugin's state (including history) is reset to its initial value,
        // preventing Cmd+Z from time-travelling into prior file content.
        editor.view.updateState(
          EditorState.create({
            doc: editor.state.doc,
            schema: editor.state.schema,
            plugins: editor.state.plugins,
          })
        )
        // The rebuild resets every plugin's state — a pending harness diff
        // highlight set just before this is wiped with it. Doc is unchanged,
        // so the same block positions re-apply cleanly.
        reapplyHarnessHighlight(editor)
        isProgrammaticUpdateRef.current = false
      }
    }
  }, [content, editor])

  // Both menus anchor to the live caret; the shared hook handles flip, shift,
  // height constraints, and scroll/resize tracking.
  useCursorMenuPosition(editor, slash?.range ?? null, slashElRef)
  useCursorMenuPosition(editor, fileMention?.range ?? null, mentionElRef)

  const selectFileMention = (file: ReferenceFile) => {
    if (!editor || !fileMention) return
    const text = `${mentionTextFor(file, openedFiles, currentFilePath)} `
    const { from, to } = fileMention.range
    setFileMention(null)
    editor.view
      .dispatch(editor.state.tr.insertText(text, from, to).scrollIntoView())
    editor.commands.focus()
  }

  const cancelFileMention = () => {
    if (editor && fileMention) {
      editor.chain().focus().deleteRange(fileMention.range).run()
    }
    setFileMention(null)
  }

  return (
    <div className="bg-[var(--bg)] relative">
      <EditorContent editor={editor} />
      {showInlinePopup && <WritingBubbleMenu />}
      <ImageGenerateDialogHost />
      {editor && slash && createPortal(
        <div
          ref={slashElRef}
          className="fixed left-0 top-0 z-[10001]"
        >
          <SlashMenuView
            ref={slashRef}
            editor={editor}
            query={slash.query}
            range={slash.range}
          />
        </div>,
        document.body,
      )}
      {editor && fileMention && createPortal(
        <div ref={mentionElRef} className="fixed left-0 top-0 z-[10001]">
          <FileMentionMenu
            ref={mentionRef}
            query={fileMention.query}
            range={fileMention.range}
            files={openedFiles}
            currentPath={currentFilePath}
            onSelect={selectFileMention}
            onCancel={cancelFileMention}
          />
        </div>,
        document.body,
      )}
    </div>
  )
}
