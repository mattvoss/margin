import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeMemoryStore, listMemories, openMemoryStore, type MemoryConfig } from './memory.server'
import { indexWorkspaceMarkdown } from './memory-indexing.server'

const directories: string[] = []
const config: MemoryConfig = {
  enabled: true, extractionEnabled: true, databasePath: undefined,
  embeddingUrl: 'http://embed.test/v1', embeddingApiKey: undefined, embeddingModel: 'embed',
  topK: 5, minimumScore: 0.45, maxPromptChars: 6000,
}

afterEach(async () => {
  while (directories.length) await rm(directories.pop()!, { recursive: true, force: true })
})

describe('workspace Markdown memory indexing', () => {
  it('indexes safe Markdown files and skips hidden, outputs, and empty files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'margin-index-'))
    directories.push(workspace)
    await mkdir(join(workspace, 'chapters'))
    await mkdir(join(workspace, 'outputs'))
    await mkdir(join(workspace, '.hidden'))
    await writeFile(join(workspace, 'chapters', 'scene.md'), '# Scene')
    await writeFile(join(workspace, 'notes.md'), 'Notes')
    await writeFile(join(workspace, 'empty.md'), '')
    await writeFile(join(workspace, 'outputs', 'log.md'), 'Generated')
    await writeFile(join(workspace, '.hidden', 'secret.md'), 'Secret')
    const store = await openMemoryStore(join(workspace, 'memory.duckdb'))
    const result = await indexWorkspaceMarkdown({
      workspaceDir: workspace, workspaceKey: workspace, store, config,
      embed: async () => [1, 0],
      extract: async ({ path }) => [{ kind: path.startsWith('chapters/') ? 'chapter' : 'project_context', content: path }],
    })
    expect(result).toMatchObject({ filesDiscovered: 3, filesIndexed: 2, filesSkipped: 1, memoriesSaved: 2 })
    expect(result.failures).toEqual([])
    expect((await listMemories(store, { workspaceKey: workspace })).map(memory => memory.content).sort())
      .toEqual(['chapters/scene.md', 'notes.md'])
    await closeMemoryStore(store)
  })

  it('keeps old source memories when extraction or embedding fails', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'margin-index-'))
    directories.push(workspace)
    await writeFile(join(workspace, 'notes.md'), 'Notes')
    const store = await openMemoryStore(join(workspace, 'memory.duckdb'))
    const first = await indexWorkspaceMarkdown({
      workspaceDir: workspace, workspaceKey: workspace, store, config,
      embed: async () => [1, 0],
      extract: async () => [{ kind: 'project_context', content: 'old memory' }],
    })
    expect(first.memoriesSaved).toBe(1)
    const second = await indexWorkspaceMarkdown({
      workspaceDir: workspace, workspaceKey: workspace, store, config,
      embed: async () => { throw new Error('embedding down') },
      extract: async () => [{ kind: 'project_context', content: 'new memory' }],
    })
    expect(second.failures).toHaveLength(1)
    expect((await listMemories(store, { workspaceKey: workspace })).map(memory => memory.content))
      .toEqual(['old memory'])
    await closeMemoryStore(store)
  })
})
