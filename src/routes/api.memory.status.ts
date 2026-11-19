import { createFileRoute } from '@tanstack/react-router'
import { join } from 'node:path'
import { json } from '../server/http.server'
import { DATA_ROOT } from '../server/env.server'
import {
  getMemoryStatus,
  memoryConfig,
  openMemoryStore,
  unavailableMemoryStatus,
} from '../server/memory.server'
import { requestSettings, requestWorkspaceDir } from '../server/storage.server'

export const Route = createFileRoute('/api/memory/status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const workspace = await requestWorkspaceDir(request)
        const config = memoryConfig(process.env, await requestSettings(request))
        const requestedEnabled = ['true', '1', 'yes'].includes((process.env.MARGIN_MEMORY_ENABLED ?? '').toLowerCase())
        if (!config.enabled || !config.embeddingUrl || !config.embeddingModel) {
          return json(unavailableMemoryStatus(config, requestedEnabled))
        }
        try {
          const store = await openMemoryStore(config.databasePath ?? join(DATA_ROOT, 'memory.duckdb'))
          try {
            return json(await getMemoryStatus(store, config, workspace))
          } finally {
            await store.close()
          }
        } catch {
          return json(unavailableMemoryStatus(config, requestedEnabled))
        }
      },
    },
  },
})
