import { createFileRoute } from '@tanstack/react-router'
import { linkWorkspace } from '../server/storage.server'
import { err, errMsg, json, readJson } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/link')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const b = await readJson(request)
        try {
          return json(
            await linkWorkspace(String(b.path ?? ''), {
              name: typeof b.name === 'string' ? b.name : undefined,
              init_git: b.init_git === true,
            }),
          )
        } catch (e) {
          return err(400, errMsg(e))
        }
      },
    },
  },
})
