// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore, type AppSettings } from './settingsStore'
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  mergeServerSettings,
  readLegacyWorkspaceDir,
  splitSettingsUpdate,
} from '../lib/settingsScope'

function storedSettings(): Record<string, unknown> | null {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
  if (!raw) return null
  return (JSON.parse(raw) as { state?: { settings?: Record<string, unknown> } }).state?.settings ?? null
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  useSettingsStore.setState({
    settings: DEFAULT_SETTINGS,
    clientSeeded: false,
    showSettings: false,
    settingsTab: null,
  })
})

describe('splitSettingsUpdate', () => {
  it('splits browser-owned keys from server-synced keys', () => {
    const { client, server } = splitSettingsUpdate({ theme: 'dark', active_endpoint: 'a', history_turns: 9 })
    expect(client).toEqual({ theme: 'dark' })
    expect(server).toEqual({ active_endpoint: 'a', history_turns: 9 })
  })

  it('routes every browser-owned key to the client half', () => {
    const { client, server } = splitSettingsUpdate({
      linked_workspace_dir: '/ws',
      default_verbosity: 'verbose',
      theme_family: 'sage',
      endpoints: {},
    })
    expect(client).toHaveProperty('linked_workspace_dir', '/ws')
    expect(client).toHaveProperty('default_verbosity', 'verbose')
    expect(client).toHaveProperty('theme_family', 'sage')
    expect(server).toEqual({ endpoints: {} })
  })
})

describe('mergeServerSettings', () => {
  const server = { ...DEFAULT_SETTINGS, theme: 'dark', history_turns: 9 } as AppSettings
  const local = { ...DEFAULT_SETTINGS, theme: 'light' } as AppSettings

  it('keeps authored browser keys once a client is seeded', () => {
    const merged = mergeServerSettings(server, local)
    expect(merged.theme).toBe('light')
    expect(merged.history_turns).toBe(9)
  })

  it('adopts the server blob while seeding a fresh client', () => {
    expect(mergeServerSettings(server, local, true).theme).toBe('dark')
  })
})

describe('settingsStore', () => {
  it('boots unseeded with defaults', () => {
    expect(useSettingsStore.getState().clientSeeded).toBe(false)
    expect(useSettingsStore.getState().settings.theme).toBe('light')
    expect(useSettingsStore.getState().settings.active_endpoint).toBeNull()
  })

  it('keeps browser-owned updates entirely local (no PATCH)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await useSettingsStore.getState().updateSettings({ theme: 'dark' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().settings.theme).toBe('dark')
    expect(useSettingsStore.getState().clientSeeded).toBe(true)
    expect(storedSettings()?.theme).toBe('dark')
  })

  it('PATCHes only the server-synced half', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await useSettingsStore.getState().updateSettings({ theme: 'dark', history_turns: 4 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/settings/')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body)).updates).toEqual({ history_turns: 4 })
  })

  it('seeds browser keys from the server once, then keeps local', async () => {
    const serverPayload = {
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      linked_workspace_dir: '/srv/workspace',
    } as AppSettings
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(serverPayload), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    // First load: unseeded -> adopt the server's client keys too.
    await useSettingsStore.getState().fetchSettings()
    expect(useSettingsStore.getState().clientSeeded).toBe(true)
    expect(useSettingsStore.getState().settings.theme).toBe('dark')
    expect(useSettingsStore.getState().settings.linked_workspace_dir).toBe('/srv/workspace')

    // This browser authorizes its own appearance; a reload must keep it.
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, theme: 'light' } })
    await useSettingsStore.getState().fetchSettings()
    expect(useSettingsStore.getState().settings.theme).toBe('light')
    expect(useSettingsStore.getState().settings.history_turns).toBe(serverPayload.history_turns)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('selectedWorkspaceDir mirrors the linked dir, null = sample', () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, linked_workspace_dir: '  /ws ' } })
    expect(useSettingsStore.getState().selectedWorkspaceDir()).toBe('/ws')
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, linked_workspace_dir: null } })
    expect(useSettingsStore.getState().selectedWorkspaceDir()).toBeNull()
  })
})

describe('legacy migration', () => {
  it('reads the pre-refactor cachedWorkspaceDir', () => {
    expect(readLegacyWorkspaceDir()).toBeNull()
    localStorage.setItem('margin:settings-workspace', JSON.stringify({ state: { cachedWorkspaceDir: '/legacy/ws' } }))
    expect(readLegacyWorkspaceDir()).toBe('/legacy/ws')
    localStorage.setItem('margin:settings-workspace', JSON.stringify({ state: { cachedWorkspaceDir: '' } }))
    expect(readLegacyWorkspaceDir()).toBeNull()
  })

  it('a fresh boot carries the legacy workspace into the new store', async () => {
    localStorage.clear()
    localStorage.setItem('margin:settings-workspace', JSON.stringify({ state: { cachedWorkspaceDir: '/legacy/ws' } }))
    vi.resetModules()
    const fresh = await import('./settingsStore')
    expect(fresh.useSettingsStore.getState().settings.linked_workspace_dir).toBe('/legacy/ws')
    expect(fresh.useSettingsStore.getState().clientSeeded).toBe(true)
  })
})