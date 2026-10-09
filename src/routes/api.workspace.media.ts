import { createFileRoute } from '@tanstack/react-router'
import { requestWorkspaceDir, saveMediaBuffer } from '../server/storage.server'
import { err, errMsg, json } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/media')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const form = await request.formData()
          const f = form.get('file')
          if (!(f instanceof File)) return err(400, 'Missing file upload')
          const bytes = new Uint8Array(await f.arrayBuffer())
          return json(
            await saveMediaBuffer(
              f.name || 'upload',
              bytes,
              f.type || undefined,
              await requestWorkspaceDir(request),
            ),
          )
        } catch (e) {
          const m = errMsg(e)
          const status = /denied/i.test(m) ? 403 : /not found/i.test(m) ? 404 : 400
          return err(status, m)
        }
      },
    },
  },
})
