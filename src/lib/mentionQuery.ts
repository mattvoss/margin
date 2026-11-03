/**
 * `@` trigger parsing shared by the manuscript editor and the assistant prompt
 * composer. Pure string work — callers supply the text before the caret.
 */

/**
 * `@` starts a reference at the beginning of a block or after whitespace /
 * opening punctuation. Filename queries never contain spaces, so typing one
 * simply closes the menu and leaves the typed text alone.
 */
const TRIGGER_BEFORE = /(?:^|[\s([{"'“‘])@([\w./-]*)$/

/** Extract a query from the text before the caret. */
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
