import type { Editor } from '@tiptap/core'

export interface FileMentionQuery {
  query: string
  range: { from: number; to: number }
}

/**
 * `@` starts a reference at the beginning of a block or after whitespace /
 * opening punctuation. Filename queries never contain spaces, so typing one
 * simply closes the menu and leaves the typed text alone.
 */
const TRIGGER_BEFORE = /(?:^|[\s([{"'“‘])@([\w./-]*)$/

/** Extract a query from the text before the caret (pure; used by tests). */
export function parseMentionQuery(
  textBefore: string,
): { query: string; atIndex: number } | null {
  const match = TRIGGER_BEFORE.exec(textBefore)
  if (!match) return null
  return {
    query: match[1],
    atIndex: textBefore.length - match[1].length - 1,
  }
}

/** The `@query` immediately before a collapsed cursor, if any. */
export function computeFileMention(editor: Editor): FileMentionQuery | null {
  const { empty, from } = editor.state.selection
  if (!empty) return null

  const $from = editor.state.selection.$from
  if (!$from.parent.isTextblock) return null
  // Code blocks are literal; don't turn `@` there into an editor affordance.
  if ($from.parent.type.name === 'codeBlock') return null
  if ($from.marks().some((mark) => mark.type.name === 'code')) return null

  // `\0` gives leaf nodes (e.g. images) a single-character stand-in so
  // offsets map 1:1 onto document positions.
  const textBefore = $from.parent.textBetween(
    0,
    $from.parentOffset,
    '\0',
    () => '\0',
  )
  const parsed = parseMentionQuery(textBefore)
  if (!parsed) return null

  const blockStart = $from.start()
  return {
    query: parsed.query,
    range: { from: blockStart + parsed.atIndex, to: from },
  }
}
