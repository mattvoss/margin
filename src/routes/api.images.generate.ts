import { createFileRoute } from '@tanstack/react-router'
import { ImageHttpError, generateImage } from '../server/images.server'
import { requestSettings, requestWorkspaceDir } from '../server/storage.server'
import { err, errMsg, json, readJson } from '../server/http.server'

export const Route = createFileRoute('/api/images/generate')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const b = await readJson(request)
        const settings = await requestSettings(request, b)
        const ws = await requestWorkspaceDir(request, b)
        try {
          const r = await generateImage(
            {
              prompt: String(b.prompt ?? ''),
              style: typeof b.style_name === 'string' ? b.style_name : null,
              reference_path: typeof b.reference_path === 'string' ? b.reference_path : null,
            },
            settings,
            ws,
          )
          return json({ path: r.path, seed: r.seed })
        } catch (e) {
          if (e instanceof ImageHttpError) return err(e.status, e.message)
          return err(502, `Image provider failed: ${errMsg(e)}`)
        }
      },
    },
  },
})
