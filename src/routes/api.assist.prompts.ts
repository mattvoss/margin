import { createFileRoute } from '@tanstack/react-router'
import { readdir } from 'node:fs/promises'
import { json } from '../server/http.server'
import { resolvePrompts } from '../server/http.server'

export const Route = createFileRoute('/api/assist/prompts')({
  server: {
    handlers: {
      GET: async () => {
        const dir = await resolvePrompts()
        try {
          const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
          return json(files.map((f) => ({ name: f, path: f })))
        } catch {
          return json([])
        }
      },
    },
  },
})
