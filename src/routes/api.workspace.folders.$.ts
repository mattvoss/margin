import { createFileRoute } from '@tanstack/react-router'
import { deleteFolder, renameFolder, requestWorkspaceDir } from '../server/storage.server'
import { dec, err, errMsg, json, readJson } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/folders/$')({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        const b = await readJson(request)
        try {
          return json(
            await renameFolder(
              dec(params._splat ?? ''),
              String(b.name ?? ''),
              await requestWorkspaceDir(request, b),
            ),
          )
        } catch (e) {
          const m = errMsg(e)
          return err(/not found/i.test(m) ? 404 : 400, m)
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          await deleteFolder(dec(params._splat ?? ''), await requestWorkspaceDir(request))
          return json({ success: true })
        } catch (e) {
          const m = errMsg(e)
          return err(/not found/i.test(m) ? 404 : 400, m)
        }
      },
    },
  },
})
