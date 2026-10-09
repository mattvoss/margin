import { createFileRoute } from '@tanstack/react-router'
import { revealGeneratedFolder } from '../server/images.server'
import { requestWorkspaceDir } from '../server/storage.server'
import { json } from '../server/http.server'

export const Route = createFileRoute('/api/images/reveal')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ws = await requestWorkspaceDir(request)
        return json(await revealGeneratedFolder(ws))
      },
    },
  },
})
