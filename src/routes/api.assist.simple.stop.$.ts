import { createFileRoute } from '@tanstack/react-router'
import { stopSession } from '../server/sessions.server'
import { dec, json } from '../server/http.server'

export const Route = createFileRoute('/api/assist/simple/stop/$')({
  server: {
    handlers: {
      POST: async ({ params }) => {
        stopSession(dec(params._splat ?? ''))
        return json({ status: 'ok' })
      },
    },
  },
})
