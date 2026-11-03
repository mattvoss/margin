import type { Editor } from '@tiptap/core'
import { parseMentionQuery } from '../../lib/mentionQuery'

export { parseMentionQuery }

export interface FileMentionQuery {
  query: string
  range: { from: number; to: number }
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
