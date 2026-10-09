import { createFileRoute } from '@tanstack/react-router'
import { HARNESS_DESCRIPTORS, getHarnessModels, isServiceTransport, resolveHarnessExe } from '../server/harness.server'
import { requestSettings, requestWorkspaceDir } from '../server/storage.server'
import { err, json } from '../server/http.server'

export const Route = createFileRoute('/api/harnesses/$id/models')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const hid = params.id
        if (!HARNESS_DESCRIPTORS[hid]) return err(404, 'Unknown harness')
        const settings = await requestSettings(request)
        try {
          const exe = isServiceTransport(hid)
            ? null
            : resolveHarnessExe(hid, (settings.harnesses ?? {}) as Record<string, { executable?: string; model?: string }>)
          const { models, manual } = await getHarnessModels(hid, exe, await requestWorkspaceDir(request))
          return json({ models, manual })
        } catch {
          return json({ models: [], manual: true })
        }
      },
    },
  },
})