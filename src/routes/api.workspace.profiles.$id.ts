import { createFileRoute } from '@tanstack/react-router'
import { deleteProfile, renameProfile } from '../server/storage.server'
import { err, errMsg, json, readJson } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/profiles/$id')({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        const b = await readJson(request)
        try {
          return json(await renameProfile(params.id, String(b.name ?? '')))
        } catch (e) {
          const m = errMsg(e)
          return err(/not found/i.test(m) ? 404 : 400, m)
        }
      },
      DELETE: async ({ request, params }) => {
        const url = new URL(request.url)
        const mode = url.searchParams.get('mode') ?? 'forget'
        try {
          return json(await deleteProfile(params.id, mode as 'forget' | 'delete'))
        } catch (e) {
          const m = errMsg(e)
          return err(/not found/i.test(m) ? 404 : 400, m)
        }
      },
    },
  },
})
