import { CLIENT_SETTINGS_HEADER, readClientSettings } from './settingsScope'

export const API_BASE = ''

/**
 * fetch for Margin's own API: attaches this browser's client-owned settings
 * (workspace, verbosity, appearance) so the server resolves them per request
 * instead of from the shared settings.json. Requests that never reach this
 * wrapper (tests, curl, scripts) simply fall back to the server's file.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const settings = readClientSettings()
  if (!settings) return fetch(input, init)
  const headers = new Headers(init?.headers)
  if (!headers.has(CLIENT_SETTINGS_HEADER)) {
    headers.set(CLIENT_SETTINGS_HEADER, encodeURIComponent(JSON.stringify(settings)))
  }
  return fetch(input, { ...init, headers })
}

/**
 * Workspace-scoped URL for loads that can't send headers (`<img src>`): the
 * client's selection travels as `linked_workspace_dir`, where ''/'sample'
 * means the default workspace.
 */
export function withWorkspaceQuery(url: string): string {
  const settings = readClientSettings()
  if (!settings) return url
  const dir = settings.linked_workspace_dir
  const value = typeof dir === 'string' ? dir.trim() : ''
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}linked_workspace_dir=${encodeURIComponent(value)}`
}
