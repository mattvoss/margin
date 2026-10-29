/**
 * Pure helpers for `@file` references in the manuscript editor.
 *
 * References are deliberately plain text: selecting a file inserts
 * `@characters/elara.md` into the document and the editor decorates it as a
 * chip. Keeping the doc as ordinary markdown means references survive
 * copy/paste, undo, git, AI rewrites, and a rename/delete (the chip simply
 * reverts to text). Nothing here touches the DOM or the editor state.
 */

export interface ReferenceFile {
  name: string
  path: string
}

export interface MentionAlias {
  /** Text after the `@` that resolves to `target` (basename or relative path). */
  alias: string
  target: ReferenceFile
}

export interface MentionMatch {
  /** Offset of the leading `@` inside the scanned text. */
  from: number
  /** Offset just past the file name. */
  to: number
  target: ReferenceFile
}

export interface MentionMatcher {
  findRanges: (text: string) => MentionMatch[]
}

/** `@` can only reference workspace markdown — never prompts or hidden paths. */
export function isReferenceablePath(path: string): boolean {
  if (!path || !path.toLowerCase().endsWith('.md')) return false
  if (path.startsWith('prompts/')) return false
  return !path.split('/').some((part) => part.startsWith('.'))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Aliases a reference can be written as. Basenames are only aliased when they
 * are unique in the workspace; otherwise references use the relative path so
 * a click can never resolve to the wrong file.
 */
export function buildMentionAliases(
  files: ReferenceFile[],
  currentPath?: string | null,
): MentionAlias[] {
  const candidates = files.filter(
    (file) => isReferenceablePath(file.path) && file.path !== currentPath,
  )

  const nameCounts = new Map<string, number>()
  for (const file of candidates) {
    nameCounts.set(file.name, (nameCounts.get(file.name) ?? 0) + 1)
  }

  const seen = new Set<string>()
  const aliases: MentionAlias[] = []
  const add = (alias: string, target: ReferenceFile) => {
    if (!alias || seen.has(alias)) return
    seen.add(alias)
    aliases.push({ alias, target: { name: target.name, path: target.path } })
  }

  for (const file of candidates) {
    if ((nameCounts.get(file.name) ?? 0) === 1) add(file.name, file)
    // Paths are always aliases. For a root file the path equals the basename,
    // which keeps `@notes.md` pointing at the root copy when a same-named file
    // lives in a folder.
    add(file.path, file)
  }

  // Longest first: the matcher re-sorts too, but keeping the list ordered
  // makes menu/debug output deterministic.
  return aliases.sort((a, b) => b.alias.length - a.alias.length)
}

/**
 * Compile one matcher for a set of aliases. Decoration passes reuse it across
 * every text node instead of rebuilding a regex per node.
 *
 * Boundaries mirror `promptMentions`: emails never match, and `@notes.md`
 * does not match inside `@notes.md.bak` while sentence punctuation after a
 * reference is allowed.
 */
export function createMentionMatcher(aliases: MentionAlias[]): MentionMatcher {
  const byAlias = new Map<string, ReferenceFile>()
  for (const { alias, target } of aliases) {
    if (!alias || !target?.path) continue
    if (!byAlias.has(alias)) byAlias.set(alias, target)
  }
  if (byAlias.size === 0) return { findRanges: () => [] }

  const alternatives = Array.from(byAlias.keys())
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')

  const pattern = new RegExp(
    `(?<![\\w@])@(${alternatives})(?![\\w-]|\\.\\w)`,
    'g',
  )

  return {
    findRanges(text: string): MentionMatch[] {
      const matches: MentionMatch[] = []
      if (!text) return matches
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const target = byAlias.get(match[1])
        if (!target) continue
        matches.push({
          from: match.index,
          to: match.index + match[0].length,
          target,
        })
      }
      return matches
    },
  }
}

export function findMentionRanges(
  text: string,
  aliases: MentionAlias[],
): MentionMatch[] {
  return createMentionMatcher(aliases).findRanges(text)
}

/**
 * Text inserted for a picked file. Duplicate basenames fall back to the
 * relative path, matching `buildMentionAliases`.
 */
export function mentionTextFor(
  file: ReferenceFile,
  files: ReferenceFile[],
  currentPath?: string | null,
): string {
  const candidates = files.filter(
    (candidate) =>
      isReferenceablePath(candidate.path) && candidate.path !== currentPath,
  )
  const duplicateName =
    candidates.filter((candidate) => candidate.name === file.name).length > 1
  return `@${duplicateName ? file.path : file.name}`
}

/**
 * Menu filter/ranking: basename-prefix matches first, then basename
 * substrings, then path matches. Ties (and the empty query) fall back to
 * alphabetical path order.
 */
export function filterMentionFiles(
  files: ReferenceFile[],
  query: string,
  currentPath?: string | null,
): ReferenceFile[] {
  const q = query.trim().toLowerCase()
  const ranked: Array<{ file: ReferenceFile; score: number }> = []

  for (const file of files) {
    if (!isReferenceablePath(file.path) || file.path === currentPath) continue

    let score: number
    if (!q) {
      score = 0
    } else {
      const name = file.name.toLowerCase()
      const path = file.path.toLowerCase()
      if (name.startsWith(q)) score = 0
      else if (name.includes(q)) score = 1
      else if (path.startsWith(q)) score = 2
      else if (path.includes(q)) score = 3
      else continue
    }

    ranked.push({ file, score })
  }

  ranked.sort(
    (a, b) => a.score - b.score || a.file.path.localeCompare(b.file.path),
  )

  return ranked.map(({ file }) => file)
}
