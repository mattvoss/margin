/**
 * Settings scope — which AppSettings live in this browser and which keep
 * round-tripping through the server's settings.json.
 *
 * Appearance (theme, text style) and Workspaces (linked dir, profiles) are
 * per-client: they are written to localStorage only (source of truth = this
 * browser) and are attached to every API request as the
 * `x-margin-client-settings` header so one server can back several
 * independently configured clients. Everything that drives shared server
 * behaviour (endpoints, harnesses, context, images, default mode, default
 * verbosity) keeps syncing through GET/PATCH /api/settings, which doubles as
 * the defaults/fallback for callers that don't send the header (CLI, tests).
 */

import type { AppSettings } from '../stores/settingsStore'

/** Browser-owned keys. The server allowlists exactly these when it overlays
 *  a request's client settings onto its own blob. */
export const CLIENT_ONLY_KEYS = [
  'linked_workspace_dir',
  'workspace_profiles',
  'theme',
  'theme_family',
  'text_style',
  'editor_stats',
] as const

/** localStorage key holding the settings blob (zustand `persist`). */
export const SETTINGS_STORAGE_KEY = 'margin:settings'
/** Pre-refactor key that cached only the workspace dir; read once on boot. */
const LEGACY_WORKSPACE_KEY = 'margin:settings-workspace'

/** Header carrying the browser-owned keys on every API request. */
export const CLIENT_SETTINGS_HEADER = 'x-margin-client-settings'

/** Mirror of `defaultSettings()` in src/server/storage.server.ts — used until
 *  the first successful GET /api/settings (and whenever storage is empty). */
export const DEFAULT_SETTINGS: AppSettings = {
  default_mode: 'edit',
  default_verbosity: 'balanced',
  show_thinking_by_default: false,
  pinned_ref_files: [],
  ignored_ref_files: [],
  endpoints: {},
  active_endpoint: null,
  default_harness: 'none',
  harnesses: {},
  is_thinking: true,
  theme: 'light',
  theme_family: 'sand',
  text_style: 'system',
  editor_stats: 'both',
  planner_include_outline: false,
  linked_workspace_dir: null,
  workspace_profiles: [],
  history_turns: 5,
  image_endpoints: {},
  active_image_endpoint: null,
  image_default_style: null,
  image_custom_styles: [],
  image_deleted_styles: [],
  image_style_overrides: {},
  image_comfy_text_workflow: null,
  image_comfy_text_prompt_map: null,
  image_comfy_text_seed_map: null,
  image_comfy_edit_workflow: null,
  image_comfy_edit_prompt_map: null,
  image_comfy_edit_image_map: null,
  image_comfy_edit_seed_map: null,
  image_comfy_negative_map: null,
}

export function isClientOnlyKey(key: string): boolean {
  return (CLIENT_ONLY_KEYS as readonly string[]).includes(key)
}

/** Split an update into the browser-owned and server-synced halves. */
export function splitSettingsUpdate(updates: Partial<AppSettings>): {
  client: Partial<AppSettings>
  server: Partial<AppSettings>
} {
  const client: Record<string, unknown> = {}
  const server: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(updates)) {
    if (isClientOnlyKey(k)) client[k] = v
    else server[k] = v
  }
  return { client: client as Partial<AppSettings>, server: server as Partial<AppSettings> }
}

/**
 * Overlay a fresh GET /api/settings payload onto local state. Server-owned
 * keys always come from the network; browser-owned keys only do for a client
 * that has never stored any (`adoptClientKeys` — the one-time seed).
 */
export function mergeServerSettings(
  server: AppSettings,
  local: AppSettings,
  adoptClientKeys = false,
): AppSettings {
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...server }
  if (adoptClientKeys) return merged
  const localState = local as unknown as Record<string, unknown>
  for (const k of CLIENT_ONLY_KEYS) {
    if (k in localState) (merged as unknown as Record<string, unknown>)[k] = localState[k]
  }
  return merged
}

/**
 * Browser-owned settings straight from localStorage — what every API request
 * carries. Always includes `linked_workspace_dir` (null = sample workspace)
 * so the server can tell "this client uses the default" from "no client".
 */
export function readClientSettings(): Partial<AppSettings> | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return null
    const stored = (JSON.parse(raw) as { state?: { settings?: Record<string, unknown> } })
      ?.state?.settings
    if (!stored || typeof stored !== 'object') return null
    const out: Record<string, unknown> = {}
    for (const k of CLIENT_ONLY_KEYS) {
      out[k] = k in stored ? stored[k] : (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k]
    }
    return out as Partial<AppSettings>
  } catch {
    return null
  }
}

/** Workspace dir cached by pre-refactor builds, migrated on first boot. */
export function readLegacyWorkspaceDir(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LEGACY_WORKSPACE_KEY)
    if (!raw) return null
    const dir = (JSON.parse(raw) as { state?: { cachedWorkspaceDir?: unknown } })?.state
      ?.cachedWorkspaceDir
    return typeof dir === 'string' && dir.trim() ? dir : null
  } catch {
    return null
  }
}

/** True once this browser has stored the settings blob. */
export function hasStoredSettings(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return Boolean(window.localStorage.getItem(SETTINGS_STORAGE_KEY))
  } catch {
    return false
  }
}
