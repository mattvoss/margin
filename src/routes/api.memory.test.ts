import { createFileRoute } from '@tanstack/react-router'
import { join } from 'node:path'
import { err, json } from '../server/http.server'
import { DATA_ROOT } from '../server/env.server'
import { createMemoryEmbedder, memoryConfig, openMemoryStore } from '../server/memory.server'
import { requestSettings, requestWorkspaceDir } from '../server/storage.server'

export const Route = createFileRoute('/api/memory/test')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await requestWorkspaceDir(request)
        const config = memoryConfig(process.env, await requestSettings(request))
        if (!config.enabled || !config.embeddingUrl || !config.embeddingModel) {
          return err(503, 'Memory embeddings are not configured')
        }
        try {
          const store = await openMemoryStore(config.databasePath ?? join(DATA_ROOT, 'memory.duckdb'))
          try {
            await createMemoryEmbedder(config)('memory health check')
          } finally {
            await store.close()
          }
          return json({ state: 'ready', embeddingModel: config.embeddingModel })
        } catch {
          return err(503, 'Memory provider or storage is unavailable')
        }
      },
    },
  },
})
