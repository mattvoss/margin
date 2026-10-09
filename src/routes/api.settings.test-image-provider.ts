import { createFileRoute } from '@tanstack/react-router'
import { testImageProvider } from '../server/settings.server'
import { requestSettings } from '../server/storage.server'
import { err, errMsg, json, readJson } from '../server/http.server'

export const Route = createFileRoute('/api/settings/test-image-provider')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const b = await readJson(request)
        try {
          return json(
            await testImageProvider(
              {
                provider: String(b.provider ?? ''),
                base_url: typeof b.base_url === 'string' ? b.base_url : undefined,
                api_key: typeof b.api_key === 'string' ? b.api_key : undefined,
                model: typeof b.model === 'string' ? b.model : undefined,
              },
              await requestSettings(request, b),
            ),
          )
        } catch (e) {
          return err(400, errMsg(e))
        }
      },
    },
  },
})