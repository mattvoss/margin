import { createFileRoute } from '@tanstack/react-router'
import { join } from 'node:path'
import { err, json } from '../server/http.server'
import { DATA_ROOT } from '../server/env.server'
import { createMemoryEmbedder, memoryConfig, openMemoryStore } from '../server/memory.server'
import { indexWorkspaceMarkdown } from '../server/memory-indexing.server'
import { requestSettings, requestWorkspaceDir } from '../server/storage.server'

export const Route = createFileRoute('/api/memory/')({
  server: { handlers: { POST: async ({ request }) => {
    const settings = await requestSettings(request)
    const config = memoryConfig(process.env, settings)
    if (!config.enabled || !config.embeddingUrl || !config.embeddingModel) {
      return err(503, 'Memory embeddings are not configured')
    }
    const workspace = await requestWorkspaceDir(request)
    const store = await openMemoryStore(config.databasePath ?? join(DATA_ROOT, 'memory.duckdb'))
    try {
      const result = await indexWorkspaceMarkdown({
        workspaceDir: workspace,
        workspaceKey: workspace,
        store,
        config,
        settings: settings as never,
        embed: createMemoryEmbedder(config),
      })
      return json(result)
    } catch (error) {
      console.warn('Workspace memory indexing failed:', error)
      return err(503, 'Workspace memory indexing failed')
    } finally {
      await store.close()
    }
  } } },
})
