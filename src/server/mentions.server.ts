/**
 * Recursive `@mention` expansion for prompt context.
 *
 * A prompt can attach documents via `@` chips. Those documents may themselves
 * contain `@references` to characters, locations, lore, or other chapters.
 * This helper walks that graph so the prompt receives the referenced documents
 * transitively, not just the ones the user picked.
 *
 * Matching reuses the editor's alias rules (`src/lib/fileMentions.ts`), so a
 * reference can be written as a unique basename or a workspace-relative path.
 * Ambiguous basenames are only resolved through their path, exactly like the
 * editor chips. Self-references and cycles are deduped by path.
 */
import {
  buildMentionAliases,
  findMentionRanges,
  type ReferenceFile,
} from '../lib/fileMentions'

export type MentionFileReader = (path: string) => Promise<string | null>

/** How many reference hops (prompt → chapter → character → …) we follow. */
export const DEFAULT_MENTION_MAX_DEPTH = 5
/** Upper bound on files one prompt may pull in, to protect the context window. */
export const DEFAULT_MENTION_MAX_FILES = 40

export interface ExpandMentionedFilesOptions {
  /** Paths explicitly attached to the prompt (`ref_files`). */
  roots?: string[]
  /** Prompt text; typed `@name` references become additional roots. */
  text?: string | null
  /** Workspace documents used to resolve aliases. */
  availableFiles: ReferenceFile[]
  readFile: MentionFileReader
  ignoredRefFiles?: Set<string> | string[] | null
  maxDepth?: number
  maxFiles?: number
}

/** Mirror of `_is_blocked`: directly ignored, or covered by its folder manifest. */
function isBlockedRef(path: string, ignored: Set<string>): boolean {
  if (ignored.size === 0) return false
  const folder = path.split('/')[0]
  return ignored.has(`${folder}/${folder.toUpperCase()}.md`) || ignored.has(path)
}

/**
 * Resolve all `@mentions` in `text` against the workspace listing.
 * `currentPath` is excluded from its own aliases, so a document cannot
 * reference itself (cycles are also caught by the caller's `seen` set).
 */
export function mentionPathsInText(
  text: string | null | undefined,
  availableFiles: ReferenceFile[],
  currentPath?: string | null,
): string[] {
  if (!text) return []
  const aliases = buildMentionAliases(availableFiles, currentPath)
  if (aliases.length === 0) return []
  return findMentionRanges(text, aliases).map((match) => match.target.path)
}

/**
 * Breadth-first walk of the mention graph.
 *
 * Roots are always kept in the result, even when they are missing from
 * `availableFiles` (an explicitly attached file should reach the model exactly
 * as before). Only files discovered through a mention are resolved against the
 * workspace listing, so hidden paths, `prompts/`, and non-markdown files never
 * leak into context. The result is sorted for stable prompt caching.
 */
export async function expandMentionedFiles(
  options: ExpandMentionedFilesOptions,
): Promise<string[]> {
  const available = options.availableFiles ?? []
  const ignored = options.ignoredRefFiles instanceof Set
    ? options.ignoredRefFiles
    : new Set(options.ignoredRefFiles ?? [])
  const maxDepth = Math.max(0, options.maxDepth ?? DEFAULT_MENTION_MAX_DEPTH)
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MENTION_MAX_FILES)

  const queue: Array<{ path: string; depth: number }> = []
  const seen = new Set<string>()
  const out: string[] = []
  let truncated = false

  const add = (raw: unknown, depth: number): void => {
    const path = typeof raw === 'string' ? raw.trim() : ''
    if (!path || seen.has(path) || isBlockedRef(path, ignored)) return
    if (out.length >= maxFiles) {
      truncated = true
      return
    }
    seen.add(path)
    out.push(path)
    queue.push({ path, depth })
  }

  const roots = [
    ...(options.roots ?? []),
    ...mentionPathsInText(options.text, available),
  ]
  for (const root of roots) add(root, 0)

  const contentCache = new Map<string, string | null>()
  while (queue.length > 0) {
    const { path, depth } = queue.shift()!
    if (depth >= maxDepth) continue

    let content = contentCache.get(path)
    if (content === undefined) {
      content = await options.readFile(path).catch(() => null)
      contentCache.set(path, content)
    }
    if (!content) continue

    for (const target of mentionPathsInText(content, available, path)) {
      add(target, depth + 1)
    }
  }

  if (truncated) {
    console.warn(
      `Margin: @mention expansion stopped at ${maxFiles} files; some referenced documents were skipped.`,
    )
  }

  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
