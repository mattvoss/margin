import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { API_BASE } from '../lib/api'
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  hasStoredSettings,
  mergeServerSettings,
  readLegacyWorkspaceDir,
  splitSettingsUpdate,
} from '../lib/settingsScope'
import { toast } from './toastStore'

export interface AppSettings {
  default_mode: string
  default_verbosity: string
  show_thinking_by_default: boolean
  pinned_ref_files: string[]
  ignored_ref_files?: string[]
  endpoints: Record<string, {
    url: string
    api_key: string
    model: string
    context_window?: number
    is_thinking?: boolean
    supports_vision?: boolean
    custom_thinking_tags?: Array<{ open: string; close: string }>
  }>
  default_context_window?: number
  active_endpoint: string | null
  default_harness?: string
  harnesses?: Record<string, { executable?: string; model?: string; context_window?: number }>
  is_thinking?: boolean
  theme?: 'light' | 'dark' | 'system'
  theme_family?: 'sand' | 'notion' | 'sage' | 'blue' | 'rose'
  text_style?: 'system' | 'editorial' | 'manuscript' | 'technical' | 'warm'
  editor_stats?: 'words' | 'characters' | 'both' | 'none'
  planner_include_outline?: boolean
  linked_workspace_dir?: string | null
  workspace_profiles?: { id: string; name: string; path: string }[]
  history_turns?: number
  image_endpoints: Record<string, {
    provider: string
    base_url: string
    api_key: string
    model: string
  }>
  active_image_endpoint: string | null
  image_default_style?: string | null
  image_custom_styles?: { name: string; prompt: string }[]
  /** Built-in style names the user hid (None can never be hidden). */
  image_deleted_styles?: string[]
  image_style_overrides?: Record<string, string>
  image_comfy_text_workflow?: Record<string, { class_type: string; inputs: Record<string, unknown> }> | null
  image_comfy_text_prompt_map?: { nodeId: string; input: string } | null
  image_comfy_text_seed_map?: { nodeId: string; input: string } | null
  image_comfy_edit_workflow?: Record<string, { class_type: string; inputs: Record<string, unknown> }> | null
  image_comfy_edit_prompt_map?: { nodeId: string; input: string } | null
  image_comfy_edit_image_map?: { nodeId: string; input: string } | null
  image_comfy_edit_seed_map?: { nodeId: string; input: string } | null
  /** Reserved for a future reference-image mapping; v1 ignores it. */
  image_comfy_negative_map?: { nodeId: string; input: string } | null
}

interface SettingsState {
  /** Full settings, hydrated synchronously from localStorage. Never null. */
  settings: AppSettings
  /**
   * True once this browser's client-owned keys (workspace, verbosity,
   * appearance) are established — either stored before, written by the user,
   * or seeded from the server's blob on a fresh client. Only then do local
   * client keys win over the GET /api/settings payload.
   */
  clientSeeded: boolean
  fetchSettings: () => Promise<void>
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>
  showSettings: boolean
  setShowSettings: (show: boolean) => void
  /** Deep-link target for the Settings modal (e.g. 'endpoints'). Consumed as
      the initial tab on open, then cleared — null means 'general'. */
  settingsTab: SettingsTabId | null
  setSettingsTab: (tab: SettingsTabId | null) => void
  /** This client's workspace: settings.linked_workspace_dir, null = sample. */
  selectedWorkspaceDir: () => string | null
}

export type SettingsTabId = 'general' | 'workspaces' | 'appearance' | 'context' | 'endpoints' | 'harnesses' | 'images'

/** First paint before localStorage is consulted: legacy builds cached only the
    workspace dir, so migrate that and otherwise start from defaults (a fresh
    client seeds once from the server). */
function bootState(): { settings: AppSettings; clientSeeded: boolean } {
  const legacyWorkspaceDir = readLegacyWorkspaceDir()
  if (legacyWorkspaceDir) {
    return { settings: { ...DEFAULT_SETTINGS, linked_workspace_dir: legacyWorkspaceDir }, clientSeeded: true }
  }
  return { settings: DEFAULT_SETTINGS, clientSeeded: hasStoredSettings() }
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...bootState(),
      showSettings: false,
      setShowSettings: (showSettings) => set({ showSettings }),
      settingsTab: null,
      setSettingsTab: (settingsTab) => set({ settingsTab }),
      selectedWorkspaceDir: () => {
        const linked = get().settings.linked_workspace_dir
        return typeof linked === 'string' && linked.trim() ? linked.trim() : null
      },
      /**
       * Refresh the server-synced keys (endpoints, harnesses, context, images).
       * The browser-owned keys are only taken from the payload the first time
       * this client ever loads — after that localStorage wins, so a reload
       * never overwrites this client's workspace, verbosity or appearance.
       */
      fetchSettings: async () => {
        try {
          const res = await fetch(`${API_BASE}/api/settings/`)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const server = (await res.json()) as AppSettings
          set((state) => ({
            settings: mergeServerSettings(server, state.settings, !state.clientSeeded),
            clientSeeded: true,
          }))
        } catch (e) {
          console.error('Failed to load settings', e)
          toast.error('Could not load shared settings — keeping this client’s values.')
        }
      },
      updateSettings: async (updates) => {
        const { client, server } = splitSettingsUpdate(updates)
        const hasClientKeys = Object.keys(client).length > 0
        // Client-owned keys are local-only; touching one means this browser has
        // stated its own configuration, so a later seed must not clobber it.
        set((state) => ({
          settings: { ...state.settings, ...updates },
          ...(hasClientKeys ? { clientSeeded: true } : {}),
        }))
        if (Object.keys(server).length === 0) return
        try {
          await fetch(`${API_BASE}/api/settings/`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates: server }),
          })
        } catch (e) {
          console.error('Failed to update settings', e)
          toast.error('Could not save that setting — it may revert on reload.')
        }
      },
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Whole blob, per client: this browser's workspace, appearance and its
      // copy of the shared keys. Transient UI stays out.
      partialize: (s) => ({ settings: s.settings, clientSeeded: s.clientSeeded }) as SettingsState,
    },
  ),
)

// zustand's persist only writes to the tab that changed — mirror writes from
// sibling tabs so every client window stays on the same configuration.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== SETTINGS_STORAGE_KEY || !event.newValue) return
    try {
      const next = (JSON.parse(event.newValue) as { state?: { settings?: AppSettings } })
        ?.state?.settings
      if (next && typeof next === 'object') {
        useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...next }, clientSeeded: true })
      }
    } catch {
      // Ignore malformed storage payloads.
    }
  })
}
