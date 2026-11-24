import { createFileRoute } from '@tanstack/react-router'
import { join } from 'node:path'
import { err, json, readJson } from '../server/http.server'
import { archiveMemoriesBySource, createMemoryEmbedder, memoryConfig, openMemoryStore, recoverMemoryStore, saveMemoryText, type MemoryStore } from '../server/memory.server'
import { extractFileMemories, memoryKindForFile } from '../server/memory-extraction.server'
import { DATA_ROOT } from '../server/env.server'
import { requestSettings, requestWorkspaceDir } from '../server/storage.server'

export const Route = createFileRoute('/api/memory/file')({
  server: { handlers: { POST: async ({ request }) => {
    const body = await readJson(request)
    if (typeof body.path !== 'string' || typeof body.content !== 'string') return err(400, 'File path and content are required')
    const kind = memoryKindForFile(body.path)
    if (!kind) return json({ saved: 0, ignored: true })
    const settings = await requestSettings(request)
    const config = memoryConfig(process.env, settings)
    if (!config.enabled || !config.extractionEnabled || !config.embeddingUrl || !config.embeddingModel) return json({ saved: 0, disabled: true })
    const workspace = await requestWorkspaceDir(request)
    const databasePath = config.databasePath ?? join(DATA_ROOT, 'memory.duckdb')
    let store: MemoryStore
    try {
      store = await openMemoryStore(databasePath)
    } catch (error) {
      console.warn('Memory database was unreadable; recreating the derived index:', error)
      store = await recoverMemoryStore(databasePath)
    }
    try {
      const candidates = await extractFileMemories({ path: body.path, content: body.content, settings: settings as never })
      const source = `file:${body.path}`
      const save = async (activeStore: NonNullable<typeof store>) => {
        await archiveMemoriesBySource(activeStore, { workspaceKey: workspace, sourceMessage: source })
        for (const candidate of candidates) {
          await saveMemoryText(activeStore, createMemoryEmbedder(config), {
            workspaceKey: workspace,
            kind: candidate.kind,
            content: candidate.content,
            sourceMessage: source,
          })
        }
      }
      try {
        await save(store)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/duckdb|io error|could not read enough bytes|corrupt|truncated/iu.test(message)) throw error
        console.warn('Memory database failed during extraction; recreating the derived index and retrying:', error)
        await store.close()
        store = await recoverMemoryStore(databasePath)
        await save(store)
      }
      return json({ saved: candidates.length, kind })
    } catch (error) {
      console.warn('File memory extraction failed:', error)
      return err(503, 'File memory extraction failed')
    } finally { await store.close() }
  } } },
})
