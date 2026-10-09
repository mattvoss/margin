import { createFileRoute } from '@tanstack/react-router'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestWorkspaceDir } from '../server/storage.server'
import { json } from '../server/http.server'

export const Route = createFileRoute('/api/assist/simple/logs')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const ws = await requestWorkspaceDir(request)
        const dir = join(ws, 'outputs', 'ai_logs')
        const all: unknown[] = []
        try {
          for (const f of await readdir(dir)) {
            if (!f.endsWith('.json')) continue
            try {
              const arr = JSON.parse(await readFile(join(dir, f), 'utf-8')) as unknown
              if (Array.isArray(arr)) all.push(...arr)
            } catch {
              continue
            }
          }
        } catch {
          // no logs yet
        }
        all.sort((a, b) => String((a as Record<string, unknown>).timestamp ?? '').localeCompare(String((b as Record<string, unknown>).timestamp ?? '')))
        return json(all)
      },
    },
  },
})
