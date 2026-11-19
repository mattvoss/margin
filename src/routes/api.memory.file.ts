import { createFileRoute } from '@tanstack/react-router'
import { join } from 'node:path'
import { err, json, readJson } from '../server/http.server'
import { archiveMemoriesBySource, createMemoryEmbedder, memoryConfig, openMemoryStore, saveMemoryText } from '../server/memory.server'
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
    const store = await openMemoryStore(config.databasePath ?? join(DATA_ROOT, 'memory.duckdb'))
    const source = `file:${body.path}`
    try {
      const candidates = await extractFileMemories({ path: body.path, content: body.content, settings: settings as never })
      await archiveMemoriesBySource(store, { workspaceKey: workspace, sourceMessage: source })
      for (const candidate of candidates) await saveMemoryText(store, createMemoryEmbedder(config), { workspaceKey: workspace, kind: candidate.kind, content: candidate.content, sourceMessage: source })
      return json({ saved: candidates.length, kind })
    } catch (error) {
      console.warn('File memory extraction failed:', error)
      return err(503, 'File memory extraction failed')
    } finally { await store.close() }
  } } },
})
