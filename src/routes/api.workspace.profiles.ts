import { createFileRoute } from '@tanstack/react-router'
import { upsertProfile } from '../server/storage.server'
import { err, errMsg, json, readJson } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/profiles')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const b = await readJson(request)
        try {
          return json(await upsertProfile(String(b.path ?? ''), String(b.name ?? '')))
        } catch (e) {
          return err(400, errMsg(e))
        }
      },
    },
  },
})
