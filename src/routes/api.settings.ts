import { createFileRoute } from '@tanstack/react-router'
import { getSettings, updateSettings } from '../server/storage.server'
import { json, readJson } from '../server/http.server'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Accept both the wrapped client shape `{ updates: {...} }` (sent by
 * settingsStore) and a raw settings dict. Never lets a stray
 * `updates`/`update` key become a persisted setting.
 */
function unwrapSettingsPayload(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(b ?? {})) {
    if ((k === 'updates' || k === 'update') && isPlainObject(v)) {
      for (const [ik, iv] of Object.entries(v)) out[ik] = iv
    } else if (k !== 'updates' && k !== 'update') {
      out[k] = v
    }
  }
  return out
}

export const Route = createFileRoute('/api/settings')({
  server: {
    handlers: {
      GET: async () => json(await getSettings()),
      PATCH: async ({ request }) => {
        const b = await readJson(request)
        const payload = unwrapSettingsPayload(b)
        return json(await updateSettings(payload))
      },
    },
  },
})
