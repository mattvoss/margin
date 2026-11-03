/**
 * Turns a stored prompt back into input-box segments, reviving `@file`
 * mentions as chips when the referenced file can be resolved.
 *
 * Matching is shared with the editor's document references: an alias is either
 * a unique basename or the workspace-relative path. Attached `ref_files` are
 * registered first, so they win when the same name resolves to different
 * paths. Anything else stays plain text — a chip without a path would look
 * right but tag nothing. Refs the log attached without embedding them in the
 * prompt text are restored too.
 */
import {
  createMentionMatcher,
  type MentionAlias,
} from './fileMentions'

export interface MentionTarget {
  name: string
  path: string
}

export type PromptSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; target: MentionTarget }

/** `@selection(1,234 ch)` — offsets live in the editor, so they can't be restored. */
const SELECTION_TOKEN = /[ \t]*@selection\([^)]*\)[ \t]*/g

/**
 * Register names and paths in order. The first target for an alias wins, so
 * `restorePromptMentions` can put log-attached refs ahead of workspace files.
 * Ambiguous names are kept (first wins) for stored history compatibility; the
 * matcher also registers every path so `@lore/notes.md` always resolves.
 */
function buildPromptAliases(targets: MentionTarget[]): MentionAlias[] {
  const seen = new Set<string>()
  const aliases: MentionAlias[] = []
  for (const target of targets) {
    if (!target?.name || !target?.path) continue
    for (const alias of [target.name, target.path]) {
      if (!alias || seen.has(alias)) continue
      seen.add(alias)
      aliases.push({ alias, target: { name: target.name, path: target.path } })
    }
  }
  return aliases.sort((a, b) => b.alias.length - a.alias.length)
}

/**
 * Split `text` into plain-text and mention segments. Only names/paths present
 * in `targets` become mentions; longest alias wins, and the first target
 * registered for an alias wins on duplicates.
 */
export function splitPromptMentions(
  text: string,
  targets: MentionTarget[],
): PromptSegment[] {
  // Selection chips can't be rebuilt (no editor offsets in the log) and the
  // backend strips the token anyway — drop it instead of leaving dead text.
  const cleaned = text
    .replace(SELECTION_TOKEN, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  const aliases = buildPromptAliases(targets)
  if (aliases.length === 0) {
    return cleaned ? [{ type: 'text', value: cleaned }] : []
  }

  const matches = createMentionMatcher(aliases).findRanges(cleaned)
  if (matches.length === 0) {
    return cleaned ? [{ type: 'text', value: cleaned }] : []
  }

  const segments: PromptSegment[] = []
  let lastIndex = 0
  for (const match of matches) {
    if (match.from > lastIndex) {
      segments.push({ type: 'text', value: cleaned.slice(lastIndex, match.from) })
    }
    segments.push({ type: 'mention', target: match.target })
    lastIndex = match.to
  }
  if (lastIndex < cleaned.length) {
    segments.push({ type: 'text', value: cleaned.slice(lastIndex) })
  }
  return segments
}

/**
 * Split a stored prompt for input-box restoration, guaranteeing that every
 * attached reference survives. Mentions already present in the text keep their
 * position; attached refs missing from the text are prepended as chips.
 *
 * `attached` (the log's `ref_files`) takes priority over `targets` (workspace
 * files) when the same alias resolves to different paths. Dedupe is by path so
 * a path mention and its `ref_files` entry produce one chip, not two.
 */
export function restorePromptMentions(
  text: string,
  attached: MentionTarget[],
  targets: MentionTarget[] = [],
): PromptSegment[] {
  const segments = splitPromptMentions(text, [...attached, ...targets])

  const matched = new Set<string>()
  for (const segment of segments) {
    if (segment.type === 'mention') matched.add(segment.target.path)
  }

  const missing: MentionTarget[] = []
  const seen = new Set<string>()
  for (const ref of attached) {
    if (!ref?.name || !ref?.path) continue
    if (matched.has(ref.path) || seen.has(ref.path)) continue
    seen.add(ref.path)
    missing.push(ref)
  }

  if (missing.length === 0) return segments

  const restored: PromptSegment[] = []
  missing.forEach((target, index) => {
    if (index > 0) restored.push({ type: 'text', value: ' ' })
    restored.push({ type: 'mention', target })
  })
  if (segments.length > 0) restored.push({ type: 'text', value: ' ' })

  for (const segment of segments) {
    const previous = restored[restored.length - 1]
    if (segment.type === 'text' && previous && previous.type === 'text') {
      previous.value += segment.value
    } else {
      restored.push(segment)
    }
  }
  return restored
}
