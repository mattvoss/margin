import { createFileRoute } from '@tanstack/react-router'
import { gitTracked } from '../server/storage.server'
import { err, errMsg, json } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/git-tracked')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        try {
          return json(await gitTracked(url.searchParams.get('path') ?? ''))
        } catch (e) {
          return err(400, errMsg(e))
        }
      },
    },
  },
})
