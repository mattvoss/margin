import { createFileRoute } from '@tanstack/react-router'
import { gitInit } from '../server/storage.server'
import { err, errMsg, json, readJson } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/git-init')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const b = await readJson(request)
        try {
          return json(await gitInit(String(b.path ?? '')))
        } catch (e) {
          return err(400, errMsg(e))
        }
      },
    },
  },
})
