/** Selected-workspace helpers (client-side, pure — no store imports). */

export const SAMPLE_WORKSPACE_SENTINEL = 'sample';

/** Effective selection: this browser's linked workspace dir. Null = sample workspace. */
export function selectedWorkspaceDir(
  settingsLinked: string | null | undefined,
): string | null {
  return typeof settingsLinked === 'string' && settingsLinked.trim() ? settingsLinked.trim() : null;
}

/** POST payload for workspace-scoped file endpoints. Null = sample (server default). */
export function workspacePayload(dir: string | null | undefined): {
  linked_workspace_dir: string | null;
} {
  const trimmed = typeof dir === 'string' ? dir.trim() : '';
  return { linked_workspace_dir: trimmed || null };
}

/** Client-side mirror of the server normalization: null/''/'sample' -> sample (undefined server-side). */
export function isSampleWorkspace(dir: string | null | undefined): boolean {
  if (dir == null) return true
  const d = String(dir).trim()
  return !d || d === SAMPLE_WORKSPACE_SENTINEL
}