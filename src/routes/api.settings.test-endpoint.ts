import { createFileRoute } from '@tanstack/react-router'
import { testEndpoint } from '../server/settings.server'
import { err, errMsg, json, readJson } from '../server/http.server'

export const Route = createFileRoute('/api/settings/test-endpoint')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const b = await readJson(request)
        const rawBase = typeof b.base_url === 'string' ? b.base_url : typeof b.url === 'string' ? b.url : ''
        try {
          return json(
            await testEndpoint({
              base_url: String(rawBase ?? ''),
              api_key: typeof b.api_key === 'string' ? b.api_key : undefined,
              model: typeof b.model === 'string' ? b.model : undefined,
            }),
          )
        } catch (e) {
          return err(400, errMsg(e))
        }
      },
    },
  },
})
