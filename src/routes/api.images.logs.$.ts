import { createFileRoute } from '@tanstack/react-router'
import { deleteImageLog } from '../server/images.server'
import { requestWorkspaceDir } from '../server/storage.server'
import { dec, err, json } from '../server/http.server'

export const Route = createFileRoute('/api/images/logs/$')({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        const ws = await requestWorkspaceDir(request)
        const ok = await deleteImageLog(ws, dec(params._splat ?? ''))
        if (!ok) return err(404, 'Image log entry not found')
        return json({ success: true })
      },
    },
  },
})
