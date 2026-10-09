import { createFileRoute } from '@tanstack/react-router'
import { requestWorkspaceDir, workspaceStats } from '../server/storage.server'
import { json } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/stats')({
  server: {
    handlers: {
      GET: async ({ request }) =>
        json({ success: true, stats: await workspaceStats(await requestWorkspaceDir(request)) }),
    },
  },
})
