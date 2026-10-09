import { createFileRoute } from '@tanstack/react-router'
import { gitStatus } from '../server/storage.server'
import { json } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/git-status')({
  server: {
    handlers: {
      GET: async () => json(await gitStatus()),
    },
  },
})
