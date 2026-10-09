import { createFileRoute } from '@tanstack/react-router'
import { listHarnesses } from '../server/harness.server'
import { requestSettings } from '../server/storage.server'
import { json } from '../server/http.server'

export const Route = createFileRoute('/api/harnesses')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const settings = await requestSettings(request)
        const list = await listHarnesses({ harnesses: settings.harnesses } as never)
        return json({
          harnesses: list.map((h) => ({
            id: h.id,
            name: h.name,
            installed: h.available,
            version: h.version,
          })),
        })
      },
    },
  },
})