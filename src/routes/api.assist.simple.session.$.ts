import { createFileRoute } from '@tanstack/react-router'
import { deleteSessionLogs } from '../server/sessions.server'
import { requestWorkspaceDir } from '../server/storage.server'
import { dec, json } from '../server/http.server'

export const Route = createFileRoute('/api/assist/simple/session/$')({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        await deleteSessionLogs(dec(params._splat ?? ''), await requestWorkspaceDir(request))
        return json({ status: 'ok' })
      },
    },
  },
})
