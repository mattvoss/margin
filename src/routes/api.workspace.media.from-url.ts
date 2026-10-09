import { createFileRoute } from '@tanstack/react-router'
import { requestWorkspaceDir, saveMediaBuffer } from '../server/storage.server'
import { err, errMsg, json, readJson } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/media/from-url')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const b = await readJson(request)
        const rawUrl = String(b.url ?? '').trim()
        if (!/^https?:\/\//i.test(rawUrl)) return err(400, 'URL must be http(s)')
        try {
          const resp = await fetch(rawUrl, { headers: { 'User-Agent': 'margin-writing-app/1.0' }, signal: AbortSignal.timeout(20000) })
          if (!resp.ok) throw new Error(`Could not fetch image: HTTP ${resp.status}`)
          const bytes = new Uint8Array(await resp.arrayBuffer())
          const pathPart = (() => {
            try {
              return new URL(rawUrl).pathname.split('/').pop() ?? ''
            } catch {
              return ''
            }
          })()
          const name = typeof b.name === 'string' && b.name ? b.name : pathPart
          return json(
            await saveMediaBuffer(
              name || 'image',
              bytes,
              resp.headers.get('content-type') ?? undefined,
              await requestWorkspaceDir(request, b),
            ),
          )
        } catch (e) {
          return err(400, `Could not fetch image: ${errMsg(e)}`)
        }
      },
    },
  },
})
