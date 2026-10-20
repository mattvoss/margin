import { createFileRoute } from '@tanstack/react-router'
import { json } from '../server/http.server'
import { listPrompts } from '../server/prompts.server'

export const Route = createFileRoute('/api/assist/prompts')({
  // NOTE: at runtime the `./prompts.$` splat child matches the bare path too
  // (empty splat) and shadows this handler. Keep both in sync.
  server: {
    handlers: {
      GET: async () => {
        try {
          return json(await listPrompts())
        } catch {
          return json([])
        }
      },
    },
  },
})
