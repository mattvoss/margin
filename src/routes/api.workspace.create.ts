import { createFileRoute } from '@tanstack/react-router'
import { createWorkspace, updateSettings, upsertProfile } from '../server/storage.server'
import { err, errMsg, json, readJson } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/create')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const b = await readJson(request)
        try {
          const res = await createWorkspace({
            parent_path: String(b.parent_path ?? ''),
            name: String(b.name ?? ''),
            init_git: b.init_git === true,
          })
          if (b.set_as_active !== false) {
            const profileName = String(b.name ?? '').trim()
            const up = await upsertProfile(res.path, profileName)
            await updateSettings({
              linked_workspace_dir: res.path,
              workspace_profiles: up.profiles,
            })
            return json({ ...res, set_as_active: true, profiles: up.profiles, profile: up.profile })
          }
          return json(res)
        } catch (e) {
          return err(400, errMsg(e))
        }
      },
    },
  },
})
