import { createFileRoute } from '@tanstack/react-router'
import { getEnvDefaults } from '../server/settings.server'
import { json } from '../server/http.server'

export const Route = createFileRoute('/api/settings/env-default')({
  server: {
    handlers: {
      GET: async () => json(getEnvDefaults()),
    },
  },
})
