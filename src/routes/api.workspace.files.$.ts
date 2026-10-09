import { createFileRoute } from '@tanstack/react-router'
import { createWorkspaceFile, deleteWorkspaceFile, listInputFiles, readWorkspaceFile, renameWorkspaceFile, requestWorkspaceDir, writeWorkspaceFile } from '../server/storage.server'
import { dec, err, errMsg, json, readJson } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/files/$')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const rel = dec(params._splat ?? '')
        // NOTE: the splat child matches the bare path too (empty splat),
        // shadowing the parent collection route — serve the listing here.
        if (!rel) {
          try {
            return json(await listInputFiles(await requestWorkspaceDir(request)))
          } catch (e) {
            return err(500, errMsg(e))
          }
        }
        try {
          const content = await readWorkspaceFile(
            rel,
            await requestWorkspaceDir(request),
          )
          return json({ content })
        } catch (e) {
          return err(404, errMsg(e))
        }
      },
      POST: async ({ request, params }) => {
        const b = await readJson(request)
        const rel = dec(params._splat ?? '')
        // Bare path (empty splat): collection endpoint — list, or create
        // when the body carries folder/name/content (parent route is
        // shadowed here, so handle both).
        if (!rel) {
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
        }
        try {
          const content = await readWorkspaceFile(
            rel,
            await requestWorkspaceDir(request, b),
          )
          return json({ content })
        } catch (e) {
          return err(404, errMsg(e))
        }
      },
      PUT: async ({ request, params }) => {
        const b = await readJson(request)
        const splat = dec(params._splat ?? '')
        const rel = splat || String(b.filename ?? b.path ?? b.name ?? '')
        if (!rel) {
          return err(400, 'filename or path is required')
        }
        try {
          await writeWorkspaceFile(
            rel,
            String(b.content ?? ''),
            await requestWorkspaceDir(request, b),
          )
          return json({ success: true })
        } catch (e) {
          return err(400, errMsg(e))
        }
      },
      PATCH: async ({ request, params }) => {
        const b = await readJson(request)
        try {
          return json(
            await renameWorkspaceFile(
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
          await deleteWorkspaceFile(
            dec(params._splat ?? ''),
            await requestWorkspaceDir(request, await readJson(request)),
          )
          return json({ success: true })
        } catch (e) {
          return err(400, errMsg(e))
        }
      },
    },
  },
})
