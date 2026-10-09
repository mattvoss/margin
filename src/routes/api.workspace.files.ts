import { createFileRoute } from '@tanstack/react-router'
import { createWorkspaceFile, listInputFiles, requestWorkspaceDir } from '../server/storage.server'
import { err, errMsg, json, readJson } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/files')({
  // NOTE: the `./files.$` splat child matches the bare path too (empty
  // splat) and shadows these handlers at runtime — collection logic is
  // duplicated there. Keep both in sync.
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          return json(await listInputFiles(await requestWorkspaceDir(request)))
        } catch (e) {
          return err(500, errMsg(e))
        }
      },
      POST: async ({ request }) => {
        const b = await readJson(request)
        // List (POST with workspace payload) vs create ({folder,name,content}).
        const isCreate = 'folder' in b || 'name' in b || 'content' in b
        if (!isCreate) {
          try {
            return json(await listInputFiles(await requestWorkspaceDir(request, b)))
          } catch (e) {
            return err(500, errMsg(e))
          }
        }
        try {
          return json(
            await createWorkspaceFile(
              String(b.folder ?? ''),
              String(b.name ?? ''),
              String(b.content ?? ''),
              await requestWorkspaceDir(request, b),
            ),
          )
        } catch (e) {
          return err(400, errMsg(e))
        }
      },
    },
  },
})
