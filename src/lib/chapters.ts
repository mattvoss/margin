/**
 * Client-side chapter detection.
 *
 * The workspace folder name for manuscript files is arbitrary (docs recommend
 * `chapters/`, but any folder works). We treat a markdown file as a chapter
 * unless it lives in one of the workspace's known support folders or is a
 * folder manifest. That keeps character sheets, style guides, lore notes, and
 * prompt files from replacing the "last focused chapter" used by Rescan.
 */

const SUPPORT_FOLDERS = new Set([
  'characters',
  'styles',
  'prompts',
  'assets',
  'outputs',
  'lore',
  'settings',
])

const ROOT_SUPPORT_FILES = new Set([
  'readme',
  'chapters',
  'characters',
  'styles',
])

export const SAMPLE_WORKSPACE_KEY = '__sample__'

export function workspaceStorageKey(dir: string | null | undefined): string {
  const trimmed = typeof dir === 'string' ? dir.trim() : ''
  return trimmed || SAMPLE_WORKSPACE_KEY
}

export function isChapterPath(path: string | null | undefined): boolean {
  if (!path) return false
  const cleaned = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned.toLowerCase().endsWith('.md')) return false

  const parts = cleaned.split('/').filter(Boolean)
  if (parts.length === 0) return false
  if (parts.some((part) => part.startsWith('.'))) return false

  const file = parts[parts.length - 1]
  const stem = file.slice(0, -3).toLowerCase()

  if (parts.length === 1) {
    return !ROOT_SUPPORT_FILES.has(stem)
  }

  const folder = parts[0].toLowerCase()
  if (SUPPORT_FOLDERS.has(folder)) return false

  // A folder manifest (`chapters/CHAPTERS.md`, `lore/LORE.md`) is not a chapter.
  const parent = parts[parts.length - 2].toLowerCase()
  if (stem === parent) return false

  return true
}

export function chapterDisplayName(path: string | null | undefined): string {
  if (!path) return ''
  const file = path.replace(/\\/g, '/').split('/').pop() ?? path
  return file
}

/**
 * The chapter Rescan targets: the last focused chapter, then the currently
 * open chapter, then the state file's last scan source.
 */
export function resolveRescanTarget(
  lastFocused: string | null | undefined,
  current: string | null | undefined,
  source: string | null | undefined,
): string | null {
  for (const candidate of [lastFocused, current, source]) {
    if (isChapterPath(candidate)) return candidate ?? null
  }
  return null
}
