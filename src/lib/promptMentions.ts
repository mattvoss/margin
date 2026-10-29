/**
 * Turns a stored prompt back into input-box segments, reviving `@file`
 * mentions as chips when the referenced file can be resolved.
 *
 * The server only tags files that arrive in `ref_files`, so a mention is only
 * revived when a matching name/path pair is known. Anything else stays plain
 * text — a chip without a path would look right but tag nothing. Refs the log
 * attached without embedding them in the prompt text are restored too.
 */

export interface MentionTarget {
  name: string
  path: string
}

export type PromptSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; target: MentionTarget }

/** `@selection(1,234 ch)` — offsets live in the editor, so they can't be restored. */
const SELECTION_TOKEN = /[ \t]*@selection\([^)]*\)[ \t]*/g

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Split `text` into plain-text and mention segments. Only names present in
 * `targets` become mentions; longest name wins when names overlap, and the
 * first target registered for a name wins on duplicates.
 */
export function splitPromptMentions(
  text: string,
  targets: MentionTarget[],
): PromptSegment[] {
  const byName = new Map<string, MentionTarget>()
  for (const target of targets) {
    if (!target?.name || !target?.path) continue
    if (!byName.has(target.name)) byName.set(target.name, target)
  }

  // Selection chips can't be rebuilt (no editor offsets in the log) and the
  // backend strips the token anyway — drop it instead of leaving dead text.
  const cleaned = text
    .replace(SELECTION_TOKEN, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  if (byName.size === 0) {
    return cleaned ? [{ type: 'text', value: cleaned }] : []
  }

  const names = Array.from(byName.keys()).sort((a, b) => b.length - a.length)
  // `(?<![\w@])` keeps emails like `name@example.com` from matching. The
  // trailing lookahead stops `@notes.md` from matching inside `@notes.md.bak`
  // while still allowing sentence punctuation: `Rewrite @notes.md.`
  const mentionRe = new RegExp(
    `(?<![\\w@])@(${names.map(escapeRegExp).join('|')})(?![\\w-]|\\.\\w)`,
    'g',
  )

  const segments: PromptSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  const pushText = (value: string) => {
    if (value) segments.push({ type: 'text', value })
  }

  while ((match = mentionRe.exec(cleaned)) !== null) {
    const target = byName.get(match[1])
    if (!target) continue

    pushText(cleaned.slice(lastIndex, match.index))
    segments.push({ type: 'mention', target })
    lastIndex = match.index + match[0].length
  }

  pushText(cleaned.slice(lastIndex))
  return segments
}

/**
 * Split a stored prompt for input-box restoration, guaranteeing that every
 * attached reference survives. Mentions already present in the text keep their
 * position; attached refs missing from the text are prepended as chips.
 *
 * `attached` (the log's `ref_files`) takes priority over `targets` (workspace
 * files) when the same name resolves to different paths.
 */
export function restorePromptMentions(
  text: string,
  attached: MentionTarget[],
  targets: MentionTarget[] = [],
): PromptSegment[] {
  const segments = splitPromptMentions(text, [...attached, ...targets])

  const matched = new Set<string>()
  for (const segment of segments) {
    if (segment.type === 'mention') matched.add(segment.target.name)
  }

  const missing: MentionTarget[] = []
  const seen = new Set<string>()
  for (const ref of attached) {
    if (!ref?.name || !ref?.path) continue
    if (matched.has(ref.name) || seen.has(ref.name)) continue
    seen.add(ref.name)
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
