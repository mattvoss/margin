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
        const params = new URL(request.url).searchParams
        const sessionFilter = params.get('session_id')
        const modeFilter = params.get('mode')
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
        const filtered = all.filter((entry) => {
          const log = entry as Record<string, unknown>
          if (sessionFilter && log.session_id !== sessionFilter) return false
          if (modeFilter && log.mode !== modeFilter) return false
          return true
        })
        return json(filtered)
      },
    },
  },
})
