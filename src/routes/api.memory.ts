import { createFileRoute } from '@tanstack/react-router'
import { join } from 'node:path'
import { err, json, readJson } from '../server/http.server'
import {
  createMemoryEmbedder,
  listMemories,
  memoryConfig,
  openMemoryStore,
  saveMemoryText,
  type MemoryKind,
} from '../server/memory.server'
import { DATA_ROOT } from '../server/env.server'
import { requestSettings, requestWorkspaceDir } from '../server/storage.server'

export const Route = createFileRoute('/api/memory')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const workspace = await requestWorkspaceDir(request)
        const params = new URL(request.url).searchParams
        const config = memoryConfig(process.env, await requestSettings(request))
        const store = await openMemoryStore(config.databasePath ?? join(DATA_ROOT, 'memory.duckdb'))
        try {
          return json(await listMemories(store, { workspaceKey: workspace,
            includeArchived: params.get('archived') === 'true',
          }))
        } finally {
          await store.close()
        }
      },
      POST: async ({ request }) => {
        const workspace = await requestWorkspaceDir(request)
        const body = await readJson(request)
        const kind = body.kind
        const content = body.content
         const validKinds = new Set<MemoryKind>(['fact', 'preference', 'skill', 'project_context', 'instruction', 'chapter', 'character', 'location', 'style'])
        if (typeof content !== 'string' || !content.trim()) return err(400, 'Memory content is required')
        if (typeof kind !== 'string' || !validKinds.has(kind as MemoryKind)) return err(400, 'Invalid memory kind')

        const config = memoryConfig(process.env, await requestSettings(request, body))
        if (!config.enabled || !config.embeddingUrl || !config.embeddingModel) {
          return err(503, 'Memory embeddings are not configured')
        }
        const store = await openMemoryStore(config.databasePath ?? join(DATA_ROOT, 'memory.duckdb'))
        try {
          const memoryId = await saveMemoryText(store, createMemoryEmbedder(config), {
            workspaceKey: workspace,
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
            kind: kind as MemoryKind,
            content,
            sourceMessage: typeof body.sourceMessage === 'string' ? body.sourceMessage : null,
          })
          return json({ memoryId }, 201)
        } finally {
          await store.close()
        }
      },
    },
  },
})
