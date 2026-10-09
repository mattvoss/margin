import { createFileRoute } from '@tanstack/react-router'
import { readMedia, requestWorkspaceDir } from '../server/storage.server'
import { dec, err, errMsg } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/media/$')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const { bytes, mime } = await readMedia(
            dec(params._splat ?? ''),
            await requestWorkspaceDir(request),
          )
          return new Response(bytes as unknown as BodyInit, { headers: { 'Content-Type': mime } })
        } catch (e) {
          const m = errMsg(e)
          const status = /denied/i.test(m) ? 403 : /not found/i.test(m) ? 404 : 400
          return err(status, m)
        }
      },
    },
  },
})
