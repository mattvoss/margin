/**
 * Shared paragraph diff helpers.
 *
 * Extracted from `applyHarnessResult.ts` so the server can detect which
 * paragraph hunks a harness changed and post-process only those, while the
 * client keeps using the same opcodes for its three-way merge.
 */

export type DiffTag = 'equal' | 'replace' | 'delete' | 'insert'

export interface Opcode {
  tag: DiffTag
  i1: number
  i2: number
  j1: number
  j2: number
}

/** Split markdown into blank-line separated, trimmed paragraphs. */
export function splitParas(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/** LCS-based opcodes, difflib style. Docs are small; O(n*m) is fine. */
export function opcodes(a: string[], b: string[]): Opcode[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: Opcode[] = []
  let i = 0
  let j = 0
  const push = (tag: DiffTag, i1: number, i2: number, j1: number, j2: number) => {
    const last = ops[ops.length - 1]
    if (last && last.tag === tag && last.i2 === i1 && last.j2 === j1) {
      last.i2 = i2
      last.j2 = j2
    } else {
      ops.push({ tag, i1, i2, j1, j2 })
    }
  }
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      const i1 = i
      const j1 = j
      while (i < n && j < m && a[i] === b[j]) {
        i++
        j++
      }
      push('equal', i1, i, j1, j)
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('delete', i, i + 1, j, j)
      i++
    } else {
      push('insert', i, i, j, j + 1)
      j++
    }
  }
  if (i < n) push('delete', i, n, j, j)
  if (j < m) push('insert', i, i, j, m)
  // Merge adjacent delete+insert pairs into replace
  const merged: Opcode[] = []
  for (const op of ops) {
    const last = merged[merged.length - 1]
    if (
      last &&
      ((last.tag === 'delete' && op.tag === 'insert') ||
        (last.tag === 'insert' && op.tag === 'delete')) &&
      last.i2 === op.i1
    ) {
      last.tag = 'replace'
      last.i2 = Math.max(last.i2, op.i2)
      last.j2 = Math.max(last.j2, op.j2)
    } else {
      merged.push({ ...op })
    }
  }
  return merged
}

/** A contiguous range that exists in the new document and should be transformed. */
export interface TextHunk {
  oldStart: number
  oldEnd: number
  newStart: number
  newEnd: number
}

/**
 * Changed paragraph hunks between two documents, in document order.
 *
 * Pure deletions produce no text to post-process and are omitted. Adjacent
 * replace/insert operations are coalesced into one hunk.
 */
export function changedHunks(before: string, after: string): TextHunk[] {
  const a = splitParas(before)
  const b = splitParas(after)
  const hunks: TextHunk[] = []
  for (const op of opcodes(a, b)) {
    if (op.tag === 'equal') continue
    const last = hunks[hunks.length - 1]
    if (last && last.oldEnd === op.i1 && last.newEnd === op.j1) {
      last.oldEnd = op.i2
      last.newEnd = op.j2
    } else {
      hunks.push({
        oldStart: op.i1,
        oldEnd: op.i2,
        newStart: op.j1,
        newEnd: op.j2,
      })
    }
  }
  return hunks.filter((hunk) => hunk.newEnd > hunk.newStart)
}
