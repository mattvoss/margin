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

/** Stable localStorage key for per-workspace client state. */
export function workspaceKey(dir: string | null | undefined): string {
  return selectedWorkspaceDir(dir) ?? SAMPLE_WORKSPACE_SENTINEL
}

/**
 * The last file edited in a workspace, if it still exists in the workspace
 * listing. Used to reopen that document after a page reload.
 */
export function rememberedFilePath(
  paths: Record<string, string> | null | undefined,
  dir: string | null | undefined,
  availablePaths: Iterable<string>,
): string | null {
  const remembered = paths?.[workspaceKey(dir)]
  if (!remembered) return null
  for (const path of availablePaths) {
    if (path === remembered) return remembered
  }
  return null
}
