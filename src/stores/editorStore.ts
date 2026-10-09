import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { Editor } from '@tiptap/react'
import { API_BASE, apiFetch } from '../lib/api'
import { workspacePayload } from '../lib/workspace'
import { useSettingsStore } from './settingsStore'
import { toast } from './toastStore'

export interface FileEntry {
  name: string
  path: string
  content: string
  originalContent: string
}

interface EditorState {
  content: string
  setContent: (content: string) => void
  isStreaming: boolean
  setIsStreaming: (isStreaming: boolean) => void
  isSaving: boolean
  setIsSaving: (saving: boolean) => void
  isApproved: boolean
  setIsApproved: (isApproved: boolean) => void
  eventSource: EventSource | null
  setEventSource: (eventSource: EventSource | null) => void
  editor: Editor | null
  setEditor: (editor: Editor | null) => void
  selectedText: string
  setSelectedText: (text: string) => void
  selectionRange: { from: number; to: number } | null
  setSelectionRange: (range: { from: number; to: number } | null) => void
  anchorPosition: number
  setAnchorPosition: (pos: number) => void
  aiAssistPreload: { text: string; range: { from: number; to: number } } | null
  setAIAssistPreload: (preload: { text: string; range: { from: number; to: number } } | null) => void
  pendingEditSelection: { text: string; from: number; to: number } | null
  setPendingEditSelection: (sel: { text: string; from: number; to: number } | null) => void
  activeContextPath: string | null
  setActiveContextPath: (path: string | null) => void
  reloadDocSignal: number
  triggerReload: () => void
  workspaceDir: string | null
  setWorkspaceDir: (dir: string | null) => void
  openedFiles: FileEntry[]
  addFile: (file: FileEntry) => void
  removeFile: (path: string) => void
  loadFileContent: (path: string, content: string) => void
  clearFiles: () => void
  currentFilePath: string | null
  setCurrentFilePath: (path: string | null) => void
  updateFileContent: (path: string, content: string) => void
  markFileClean: (path: string) => void
  aiPendingEdit: { previousContent: string; selectionRange?: { from: number; to: number } | null; highlightFrom?: number; harness?: string; aiContent?: string; aiChangedIdx?: number[] } | null
  setAiPendingEdit: (edit: { previousContent: string; selectionRange?: { from: number; to: number } | null; highlightFrom?: number; harness?: string; aiContent?: string; aiChangedIdx?: number[] } | null) => void
  acceptAiEdit: () => Promise<void>
  activeModel: string | null
  setActiveModel: (model: string | null) => void
  autoSaveTimer: ReturnType<typeof setTimeout> | null
  cancelAutoSave: () => void
  flushSave: () => void
  saveFile: (path: string, content: string) => Promise<void>
}

export const useEditorStore = create<EditorState>()(
  persist(
    (set) => ({
  content: '',
  setContent: (content) => {
    set({ content })
    const state = useEditorStore.getState()
    const timer = state.autoSaveTimer
    if (timer) {
      clearTimeout(timer)
    }
    // Mid-stream: the editor is receiving partial model output, so scheduling
    // a save would persist an incomplete chunk sequence to disk. Persistence
    // resumes after the stream ends (via the review flow or the next edit).
    if (state.isStreaming) {
      set({ autoSaveTimer: null })
      return
    }
    const path = state.currentFilePath
    if (!path) {
      set({ autoSaveTimer: null })
      return
    }
    if (path.startsWith('prompts/')) {
      set({ autoSaveTimer: null })
      return
    }
    const file = state.openedFiles.find((f) => f.path === path)
    if (!file) {
      set({ autoSaveTimer: null })
      return
    }
    const contentToSave = state.aiPendingEdit
      ? state.aiPendingEdit.previousContent
      : content
    if (contentToSave === file.originalContent) {
      set({ autoSaveTimer: null })
      return
    }
    const newTimer = setTimeout(async () => {
      try {
        const current = useEditorStore.getState()
        const currentPath = current.currentFilePath
        if (!currentPath || currentPath !== path) {
          set({ autoSaveTimer: null })
          return
        }
        if (currentPath.startsWith('prompts/')) {
          set({ autoSaveTimer: null })
          return
        }
        const currentFile = current.openedFiles.find((f) => f.path === currentPath)
        if (!currentFile) {
          set({ autoSaveTimer: null })
          return
        }
        const cts = current.aiPendingEdit
          ? current.aiPendingEdit.previousContent
          : current.content
        if (cts === currentFile.originalContent) {
          set({ autoSaveTimer: null })
          return
        }
        set({ isSaving: true })
        await current.saveFile(currentPath, cts)
      } catch (err) {
        console.error('Failed to auto-save:', err)
      } finally {
        set({ autoSaveTimer: null, isSaving: false })
      }
    }, 1000)
    set({ autoSaveTimer: newTimer })
  },
  isStreaming: false,
  setIsStreaming: (isStreaming) => set({ isStreaming }),
  isSaving: false,
  setIsSaving: (saving) => set({ isSaving: saving }),
  isApproved: false,
  setIsApproved: (isApproved) => set({ isApproved }),
  eventSource: null,
  setEventSource: (eventSource) => set({ eventSource }),
  editor: null,
  setEditor: (editor) => set({ editor }),
  selectedText: '',
  setSelectedText: (selectedText) => set({ selectedText }),
  selectionRange: null,
  setSelectionRange: (selectionRange) => set({ selectionRange }),
  anchorPosition: 0,
  setAnchorPosition: (anchorPosition) => set({ anchorPosition }),
  aiAssistPreload: null,
  setAIAssistPreload: (aiAssistPreload) => set({ aiAssistPreload }),
  pendingEditSelection: null,
  setPendingEditSelection: (pendingEditSelection) => set({ pendingEditSelection }),
  activeContextPath: null,
  setActiveContextPath: (activeContextPath) => set({ activeContextPath }),
  reloadDocSignal: 0,
  triggerReload: () => set((state) => ({ reloadDocSignal: state.reloadDocSignal + 1 })),
  workspaceDir: null,
  setWorkspaceDir: (workspaceDir) => set({ workspaceDir }),
  openedFiles: [],
  addFile: (file) =>
    set((state) => ({
      openedFiles: state.openedFiles.some((f) => f.path === file.path)
        ? state.openedFiles
        : [...state.openedFiles, { ...file, originalContent: file.content }],
    })),
  removeFile: (path) =>
    set((state) => {
      const timer = state.autoSaveTimer
      if (timer && state.currentFilePath === path) {
        clearTimeout(timer)
      }
      return {
        openedFiles: state.openedFiles.filter((f) => f.path !== path),
        ...(state.currentFilePath === path ? { autoSaveTimer: null } : {}),
      }
    }),
  loadFileContent: (path, content) =>
    set((state) => ({
      openedFiles: state.openedFiles.map((f) =>
        f.path === path ? { ...f, content, originalContent: content } : f
      ),
    })),
  clearFiles: () => {
    const timer = useEditorStore.getState().autoSaveTimer
    if (timer) {
      clearTimeout(timer)
    }
    set({
      openedFiles: [],
      workspaceDir: null,
      currentFilePath: null,
      content: '',
      selectedText: '',
      selectionRange: null,
      anchorPosition: 0,
      aiAssistPreload: null,
      pendingEditSelection: null,
      aiPendingEdit: null,
      autoSaveTimer: null,
    })
  },
  currentFilePath: null,
  setCurrentFilePath: (currentFilePath) => {
    const state = useEditorStore.getState()
    const timer = state.autoSaveTimer
    if (timer) {
      clearTimeout(timer)
    }
    set({ currentFilePath, autoSaveTimer: null })
  },
  updateFileContent: (path, content) =>
    set((state) => ({
      openedFiles: state.openedFiles.map((f) =>
        f.path === path ? { ...f, content } : f
      ),
    })),
  markFileClean: (path) =>
    set((state) => ({
      openedFiles: state.openedFiles.map((f) =>
        f.path === path ? { ...f, originalContent: f.content } : f
      ),
    })),
  aiPendingEdit: null,
  setAiPendingEdit: (aiPendingEdit) => set({ aiPendingEdit }),
  // Accept a pending (non-harness) AI edit: drop the review state and persist
  // the accepted content. Autosave deliberately writes `previousContent` while
  // a review is pending (see setContent/flushSave), so accepting must save
  // explicitly or the AI text would live only in the client. Harness reviews
  // persist via resolveHarnessReview instead.
  acceptAiEdit: async () => {
    const s = useEditorStore.getState()
    s.editor?.commands.clearAiHighlight()
    s.setAiPendingEdit(null)
    const path = s.currentFilePath
    if (!path || path.startsWith('prompts/')) return
    const file = s.openedFiles.find((f) => f.path === path)
    if (!file || s.content === file.originalContent) return
    try {
      await s.saveFile(path, s.content)
    } catch (err) {
      console.error('Failed to save accepted AI edit:', err)
    }
  },
  activeModel: null,
  setActiveModel: (activeModel) => set({ activeModel }),
  autoSaveTimer: null,
  cancelAutoSave: () => {
    const timer = useEditorStore.getState().autoSaveTimer
    if (timer) {
      clearTimeout(timer)
    }
    set({ autoSaveTimer: null })
  },
  flushSave: async () => {
    const state = useEditorStore.getState()
    const timer = state.autoSaveTimer
    if (timer) {
      clearTimeout(timer)
      set({ autoSaveTimer: null })
    }
    // Never flush partial streamed content to disk.
    if (state.isStreaming) return
    const path = state.currentFilePath
    if (!path) return
    if (path.startsWith('prompts/')) return
    const file = state.openedFiles.find((f) => f.path === path)
    if (!file) return
    const contentToSave = state.aiPendingEdit
      ? state.aiPendingEdit.previousContent
      : state.content
    if (contentToSave === file.originalContent) return
    try {
      set({ isSaving: true })
      await useEditorStore.getState().saveFile(path, contentToSave)
    } catch (err) {
      console.error('Failed to flush save:', err)
    } finally {
      set({ isSaving: false })
    }
  },
  saveFile: async (path: string, content: string) => {
    try {
      set({ isSaving: true })
      const res = await apiFetch(`${API_BASE}/api/workspace/files`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: path,
          content,
          ...workspacePayload(useSettingsStore.getState().selectedWorkspaceDir()),
        }),
      })
      if (res.ok) {
        useEditorStore.getState().markFileClean(path)
      } else {
        const err = await res.json().catch(() => ({}))
        toast.error(`Failed to save file: ${err.detail || res.statusText}`)
      }
    } catch (err) {
      toast.error(
        `Failed to save file: ${err instanceof Error ? err.message : 'Unknown error'}`,
      )
      throw err
    } finally {
      set({ isSaving: false })
    }
  },
    }),
    {
      name: 'margin:editor-workspace',
      storage: createJSONStorage(() => localStorage),
      // Marker only ('custom'/'sample') for instant first paint; file
      // contents and editor state stay session-only.
      partialize: (s) => ({ workspaceDir: s.workspaceDir }) as EditorState,
    },
  ),
)
