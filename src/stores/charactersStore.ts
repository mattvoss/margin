import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { API_BASE, apiFetch } from '../lib/api'
import {
  chapterDisplayName,
  isChapterPath,
  resolveRescanTarget,
  workspaceStorageKey,
} from '../lib/chapters'
import type { CharacterDraft, CharacterState } from '../lib/characters'
import { useEditorStore } from './editorStore'
import { useSettingsStore } from './settingsStore'

export interface LastChapterRef {
  path: string
  name: string
  focusedAt: string
}

type ExtractMode = 'passage' | 'rescan'

interface ExtractionPayload {
  mode: ExtractMode
  generated_text?: string
  document_text?: string
  file_path?: string | null
  session_id?: string | null
}

interface CharactersState {
  state: CharacterState | null
  lastChapterByWorkspace: Record<string, LastChapterRef>
  loading: boolean
  tracking: boolean
  saving: boolean
  error: string | null
  dialogOpen: boolean
  editing: boolean
  /** A generation finished while the dialog was in edit mode. */
  stale: boolean
  abortController: AbortController | null

  fetchState: () => Promise<void>
  rescanOrExtract: (payload: ExtractionPayload) => Promise<void>
  trackAfterGeneration: (opts: {
    text: string
    filePath: string | null
    sessionId: string | null
    /** Workspace the generation started in; aborts tracking if it changed. */
    workspaceDir?: string | null
  }) => Promise<void>
  rescanLastChapter: () => Promise<void>
  setDialogOpen: (open: boolean) => void
  setEditing: (editing: boolean) => void
  rememberChapter: (workspaceDir: string | null | undefined, path: string) => void
  updateCharacter: (id: string, updates: Partial<CharacterDraft>) => Promise<void>
  createCharacter: (character: CharacterDraft) => Promise<void>
  deleteCharacter: (id: string) => Promise<void>
  resetForWorkspace: () => void
  clearError: () => void
}

let fetchSequence = 0

async function responseError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { detail?: unknown } | null
  return typeof data?.detail === 'string' && data.detail
    ? data.detail
    : `Request failed (${res.status})`
}

function autoTrackingEnabled(): boolean {
  const settings = useSettingsStore.getState().settings
  // Extraction only uses the active endpoint. Harness-only setups should not
  // paint an error dot after every generation, so silently skip them.
  return settings.character_tracking !== false && !!settings.active_endpoint
}

export const useCharactersStore = create<CharactersState>()(
  persist(
    (set, get) => ({
      state: null,
      lastChapterByWorkspace: {},
      loading: false,
      tracking: false,
      saving: false,
      error: null,
      dialogOpen: false,
      editing: false,
      stale: false,
      abortController: null,

      fetchState: async () => {
        const sequence = ++fetchSequence
        set({ loading: true, error: null })
        try {
          const res = await apiFetch(`${API_BASE}/api/assist/characters`, {
            cache: 'no-store',
          })
          if (!res.ok) throw new Error(await responseError(res))
          const data = (await res.json()) as { state?: CharacterState }
          if (sequence !== fetchSequence) return
          set({ state: data.state ?? null })
        } catch (e) {
          if (sequence !== fetchSequence) return
          set({ error: (e as Error).message })
        } finally {
          if (sequence === fetchSequence) set({ loading: false })
        }
      },

      rescanOrExtract: async (payload) => {
        get().abortController?.abort()
        fetchSequence += 1
        const controller = new AbortController()
        set({ abortController: controller, tracking: true, loading: false, error: null })

        try {
          const res = await apiFetch(`${API_BASE}/api/assist/characters`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          })
          if (!res.ok) throw new Error(await responseError(res))
          const data = (await res.json()) as { state?: CharacterState }
          if (get().abortController !== controller) return
          if (data.state) set({ state: data.state, stale: false })

          if (payload.file_path) {
            const dir = useSettingsStore.getState().selectedWorkspaceDir()
            get().rememberChapter(dir, payload.file_path)
          }
        } catch (e) {
          if (
            get().abortController === controller &&
            (e as Error).name !== 'AbortError'
          ) {
            set({ error: (e as Error).message })
          }
        } finally {
          if (get().abortController === controller) {
            set({ tracking: false, abortController: null })
          }
        }
      },

      trackAfterGeneration: async ({ text, filePath, sessionId, workspaceDir }) => {
        if (!autoTrackingEnabled()) return
        if (!text.trim()) return
        if (workspaceDir !== undefined) {
          const current = useSettingsStore.getState().selectedWorkspaceDir()
          if ((workspaceDir ?? null) !== current) return
        }
        if (get().editing || get().saving) {
          set({ stale: true })
          return
        }
        await get().rescanOrExtract({
          mode: 'passage',
          generated_text: text,
          file_path: filePath,
          session_id: sessionId,
        })
      },

      rescanLastChapter: async () => {
        const dir = useSettingsStore.getState().selectedWorkspaceDir()
        const key = workspaceStorageKey(dir)
        const last = get().lastChapterByWorkspace[key]?.path ?? null
        const current = useEditorStore.getState().currentFilePath
        const source = get().state?.source_path ?? null
        const target = resolveRescanTarget(last, current, source)

        if (!target) {
          set({ error: 'Open a chapter first, then rescan.' })
          return
        }

        const documentText =
          current === target ? useEditorStore.getState().content : undefined
        await get().rescanOrExtract({
          mode: 'rescan',
          file_path: target,
          document_text: documentText,
          session_id: null,
        })
      },

      setDialogOpen: (open) => {
        set({ dialogOpen: open, ...(open ? {} : { editing: false }) })
      },

      setEditing: (editing) => {
        if (editing) {
          get().abortController?.abort()
          set({ editing: true, tracking: false })
        } else {
          set({ editing: false })
        }
      },

      rememberChapter: (workspaceDir, path) => {
        if (!isChapterPath(path)) return
        const key = workspaceStorageKey(workspaceDir)
        set((state) => ({
          lastChapterByWorkspace: {
            ...state.lastChapterByWorkspace,
            [key]: {
              path,
              name: chapterDisplayName(path),
              focusedAt: new Date().toISOString(),
            },
          },
        }))
      },

      updateCharacter: async (id, updates) => {
        const sequence = ++fetchSequence
        set({ saving: true, loading: false, error: null })
        try {
          const res = await apiFetch(`${API_BASE}/api/assist/characters`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'update', id, updates }),
          })
          if (!res.ok) throw new Error(await responseError(res))
          const data = (await res.json()) as { state?: CharacterState }
          if (sequence !== fetchSequence) return
          if (data.state) set({ state: data.state })
        } catch (e) {
          if (sequence === fetchSequence) set({ error: (e as Error).message })
          throw e
        } finally {
          set({ saving: false })
        }
      },

      createCharacter: async (character) => {
        const sequence = ++fetchSequence
        set({ saving: true, loading: false, error: null })
        try {
          const res = await apiFetch(`${API_BASE}/api/assist/characters`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'create', character }),
          })
          if (!res.ok) throw new Error(await responseError(res))
          const data = (await res.json()) as { state?: CharacterState }
          if (sequence !== fetchSequence) return
          if (data.state) set({ state: data.state })
        } catch (e) {
          if (sequence === fetchSequence) set({ error: (e as Error).message })
          throw e
        } finally {
          set({ saving: false })
        }
      },

      deleteCharacter: async (id) => {
        const sequence = ++fetchSequence
        set({ saving: true, loading: false, error: null })
        try {
          const res = await apiFetch(`${API_BASE}/api/assist/characters`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', id }),
          })
          if (!res.ok) throw new Error(await responseError(res))
          const data = (await res.json()) as { state?: CharacterState }
          if (sequence !== fetchSequence) return
          if (data.state) set({ state: data.state })
        } catch (e) {
          if (sequence === fetchSequence) set({ error: (e as Error).message })
          throw e
        } finally {
          set({ saving: false })
        }
      },

      resetForWorkspace: () => {
        fetchSequence += 1
        get().abortController?.abort()
        set({
          state: null,
          loading: false,
          tracking: false,
          saving: false,
          error: null,
          dialogOpen: false,
          editing: false,
          stale: false,
          abortController: null,
        })
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'margin:characters',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) =>
        ({ lastChapterByWorkspace: state.lastChapterByWorkspace }) as CharactersState,
    },
  ),
)
