import { createFileRoute } from '@tanstack/react-router'
import { join } from 'node:path'
import { json } from '../server/http.server'
import { listMemories, memoryConfig, openMemoryStore } from '../server/memory.server'
import { DATA_ROOT } from '../server/env.server'
import { requestWorkspaceDir } from '../server/storage.server'

export const Route = createFileRoute('/api/memory')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const workspace = await requestWorkspaceDir(request)
        const params = new URL(request.url).searchParams
        const config = memoryConfig()
        const store = await openMemoryStore(config.databasePath ?? join(DATA_ROOT, 'memory.duckdb'))
        try {
          return json(await listMemories(store, { workspaceKey: workspace,
            includeArchived: params.get('archived') === 'true',
          }))
        } finally {
          await store.close()
        }
      },
    },
  },
})
