import { createFileRoute } from '@tanstack/react-router'
import { join } from 'node:path'
import { err, json, dec } from '../server/http.server'
import { archiveMemory, memoryConfig, openMemoryStore, replaceMemoryMentions } from '../server/memory.server'
import { mentionForPath } from '../server/memory-references.server'
import { DATA_ROOT } from '../server/env.server'
import { listMarkdownFiles, requestSettings, requestWorkspaceDir } from '../server/storage.server'

export const Route = createFileRoute('/api/memory/$id')({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        const workspace = await requestWorkspaceDir(request)
        const config = memoryConfig(process.env, await requestSettings(request))
        const store = await openMemoryStore(config.databasePath ?? join(DATA_ROOT, 'memory.duckdb'))
        try {
          const archived = await archiveMemory(store, {
            workspaceKey: workspace,
            memoryId: dec(params.id ?? ''),
          })
          return archived ? json({ status: 'ok' }) : err(404, 'Memory not found')
        } finally {
          await store.close()
        }
      },
      PATCH: async ({ request, params }) => {
        const workspace = await requestWorkspaceDir(request)
        const body = await request.json().catch(() => null) as { mentions?: unknown } | null
        if (!body || !Array.isArray(body.mentions) || body.mentions.some(path => typeof path !== 'string')) {
          return err(400, 'mentions must be an array of file paths')
        }
        let mentions
        try {
          mentions = body.mentions.map(path => mentionForPath(path as string))
        } catch {
          return err(400, 'Invalid related file path')
        }
        const availablePaths = new Set(await listMarkdownFiles(workspace))
        if (mentions.some(mention => !availablePaths.has(mention.path))) {
          return err(400, 'Related file does not exist in this workspace')
        }
        const config = memoryConfig(process.env, await requestSettings(request))
        const store = await openMemoryStore(config.databasePath ?? join(DATA_ROOT, 'memory.duckdb'))
        try {
          const updated = await replaceMemoryMentions(store, {
            workspaceKey: workspace,
            memoryId: dec(params.id ?? ''),
            mentions,
          })
          return updated ? json({ status: 'ok' }) : err(404, 'Memory not found')
        } finally {
          await store.close()
        }
      },
    },
  },
})
