import { createFileRoute } from '@tanstack/react-router'
import { join } from 'node:path'
import { err, json, dec } from '../server/http.server'
import { archiveMemory, memoryConfig, openMemoryStore } from '../server/memory.server'
import { DATA_ROOT } from '../server/env.server'
import { requestWorkspaceDir } from '../server/storage.server'

export const Route = createFileRoute('/api/memory/$')({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        const workspace = await requestWorkspaceDir(request)
        const config = memoryConfig()
        const store = await openMemoryStore(config.databasePath ?? join(DATA_ROOT, 'memory.duckdb'))
        try {
          const archived = await archiveMemory(store, {
            workspaceKey: workspace,
            memoryId: dec(params._splat ?? ''),
          })
          return archived ? json({ status: 'ok' }) : err(404, 'Memory not found')
        } finally {
          await store.close()
        }
      },
    },
  },
})
