import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeMemoryStore, listMemories, openMemoryStore } from './memory.server'
import { extractAndSaveMemories, parseMemoryCandidates } from './memory-extraction.server'

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

describe('memory extraction', () => {
  it('accepts only valid, bounded memory candidates', () => {
    expect(parseMemoryCandidates(JSON.stringify({
      memories: [
        { kind: 'preference', content: 'The user prefers concise answers.' },
        { kind: 'unknown', content: 'discard me' },
        { kind: 'fact', content: 'x'.repeat(5000) },
      ],
    }))).toEqual([
      { kind: 'preference', content: 'The user prefers concise answers.' },
    ])
  })

  it('extracts JSON embedded in a model response and rejects malformed output', () => {
    expect(parseMemoryCandidates('Here is the result:\n{"memories":[{"kind":"fact","content":"The user writes fiction."}]}'))
      .toEqual([{ kind: 'fact', content: 'The user writes fiction.' }])
    expect(parseMemoryCandidates('not json')).toEqual([])
  })

  it('extracts and persists candidates without exposing model output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'margin-memory-'))
    temporaryDirectories.push(directory)
    const store = await openMemoryStore(join(directory, 'memory.duckdb'))

    await extractAndSaveMemories({
      store,
      workspaceKey: 'workspace-a',
      sessionId: 'session-a',
      userMessage: 'I prefer concise answers.',
      assistantMessage: 'I will keep answers concise.',
      embed: async () => [1, 0],
      generate: async () => '{"memories":[{"kind":"preference","content":"The user prefers concise answers."}]}',
    })

    expect((await listMemories(store, { workspaceKey: 'workspace-a' }))[0]?.content)
      .toBe('The user prefers concise answers.')
    await closeMemoryStore(store)
  })
})
