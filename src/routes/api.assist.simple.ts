import { createFileRoute } from '@tanstack/react-router'
import { normalizeSimpleAssistRequest } from '../server/assist.server'
import { runSimpleAssist } from '../server/assist-stream.server'
import { err, readJson } from '../server/http.server'

export const Route = createFileRoute('/api/assist/simple')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readJson(request)
        const payload = normalizeSimpleAssistRequest(body)
        if (!payload.message.trim()) return err(400, 'Missing message')
        return runSimpleAssist(payload, request)
      },
    },
  },
})