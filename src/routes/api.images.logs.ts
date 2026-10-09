import { createFileRoute } from '@tanstack/react-router'
import { getImageLogs } from '../server/images.server'
import { requestWorkspaceDir } from '../server/storage.server'
import { json } from '../server/http.server'

export const Route = createFileRoute('/api/images/logs')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const ws = await requestWorkspaceDir(request)
        return json({ logs: await getImageLogs(ws) })
      },
    },
  },
})
