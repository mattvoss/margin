import { createFileRoute } from '@tanstack/react-router'
import { gitRemove } from '../server/storage.server'
import { err, errMsg, json } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/git')({
  server: {
    handlers: {
      DELETE: async ({ request }) => {
        const url = new URL(request.url)
        try {
          return json(await gitRemove(url.searchParams.get('path') ?? ''))
        } catch (e) {
          return err(400, errMsg(e))
        }
      },
    },
  },
})
