import { createFileRoute } from '@tanstack/react-router'
import { browseFolders } from '../server/storage.server'
import { err, errMsg, json } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/browse')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        try {
          return json(await browseFolders(url.searchParams.get('path') ?? ''))
        } catch (e) {
          const m = errMsg(e)
          const status = /not allowed|denied/i.test(m) ? 403 : /absolute|invalid|required/i.test(m) ? 400 : /does not exist/i.test(m) ? 404 : 400
          return err(status, m)
        }
      },
    },
  },
})
