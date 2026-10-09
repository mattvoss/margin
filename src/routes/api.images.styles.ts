import { createFileRoute } from '@tanstack/react-router'
import { listStyles } from '../server/images.server'
import { requestSettings } from '../server/storage.server'
import { json } from '../server/http.server'

export const Route = createFileRoute('/api/images/styles')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const settings = await requestSettings(request)
        return json({ styles: listStyles(settings) })
      },
    },
  },
})