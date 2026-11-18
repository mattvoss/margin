import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  closeMemoryStore,
  openMemoryStore,
  saveMemory,
  searchMemories,
} from './memory.server'

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

describe('memory store', () => {
  it('opens a persistent database and creates the memory schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'margin-memory-'))
    temporaryDirectories.push(directory)

    const store = await openMemoryStore(join(directory, 'memory.duckdb'))
    const tables = await store.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'memories'",
    )

    expect(tables).toEqual([{ table_name: 'memories' }])

    await closeMemoryStore(store)
  })

  it('saves memories and searches only within the requested workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'margin-memory-'))
    temporaryDirectories.push(directory)
    const store = await openMemoryStore(join(directory, 'memory.duckdb'))

    await saveMemory(store, {
      workspaceKey: 'workspace-a',
      kind: 'preference',
      content: 'The user prefers concise answers.',
      embedding: [1, 0, 0],
    })
    await saveMemory(store, {
      workspaceKey: 'workspace-b',
      kind: 'preference',
      content: 'The other workspace prefers long answers.',
      embedding: [1, 0, 0],
    })
    await saveMemory(store, {
      workspaceKey: 'workspace-a',
      kind: 'fact',
      content: 'The user writes fiction.',
      embedding: [0, 1, 0],
    })

    const results = await searchMemories(store, {
      workspaceKey: 'workspace-a',
      embedding: [1, 0, 0],
      limit: 5,
    })

    expect(results).toHaveLength(2)
    expect(results[0]?.content).toBe('The user prefers concise answers.')
    expect(results[0]?.score).toBeCloseTo(1)
    expect(results.some(result => result.content.includes('other workspace'))).toBe(false)

    await closeMemoryStore(store)
  })

  it('rejects invalid embeddings before writing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'margin-memory-'))
    temporaryDirectories.push(directory)
    const store = await openMemoryStore(join(directory, 'memory.duckdb'))

    await expect(
      saveMemory(store, {
        workspaceKey: 'workspace-a',
        kind: 'fact',
        content: 'A memory',
        embedding: [],
      }),
    ).rejects.toThrow('embedding')

    await closeMemoryStore(store)
  })
})
