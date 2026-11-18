import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeMemoryStore, openMemoryStore } from './memory.server'

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
})
