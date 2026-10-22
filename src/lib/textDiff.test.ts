import { describe, it, expect } from 'vitest'
import { changedHunks, opcodes, splitParas } from './textDiff'

describe('splitParas', () => {
  it('splits on blank lines, trims, and drops empties', () => {
    expect(splitParas('  A  \n\n\nB\n  \n\nC\n')).toEqual(['A', 'B', 'C'])
  })
})

describe('opcodes', () => {
  it('reports equal, replace, insert, and delete ranges', () => {
    const ops = opcodes(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])
    expect(ops).toEqual([
      { tag: 'equal', i1: 0, i2: 1, j1: 0, j2: 1 },
      { tag: 'replace', i1: 1, i2: 2, j1: 1, j2: 2 },
      { tag: 'equal', i1: 2, i2: 3, j1: 2, j2: 3 },
      { tag: 'insert', i1: 3, i2: 3, j1: 3, j2: 4 },
    ])
  })
})

describe('changedHunks', () => {
  it('returns the new side of replacements', () => {
    expect(changedHunks('A\n\nB\n\nC', 'A\n\nB2\n\nC')).toEqual([
      { oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 },
    ])
  })

  it('omits pure deletions because there is no text to transform', () => {
    expect(changedHunks('A\n\nB\n\nC', 'A\n\nC')).toEqual([])
  })

  it('keeps insertions and multiple hunks in document order', () => {
    expect(changedHunks('A\n\nB\n\nC', 'A1\n\nB\n\nC1\n\nD')).toEqual([
      { oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 },
      { oldStart: 2, oldEnd: 3, newStart: 2, newEnd: 4 },
    ])
  })
})
