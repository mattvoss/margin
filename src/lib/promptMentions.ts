/**
 * Turns a stored prompt back into input-box segments, reviving `@file`
 * mentions as chips when the referenced file can be resolved.
 *
 * The server only tags files that arrive in `ref_files`, so a mention is only
 * revived when a matching name/path pair is known. Anything else stays plain
 * text — a chip without a path would look right but tag nothing.
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
  // `(?<![\w@])` keeps emails like `name@example.com` from matching, and the
  // trailing lookahead stops `@notes.md` from matching inside `@notes.md.bak`.
  const mentionRe = new RegExp(
    `(?<![\\w@])@(${names.map(escapeRegExp).join('|')})(?![\\w.-])`,
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
