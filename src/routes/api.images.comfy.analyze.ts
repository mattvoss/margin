import { createFileRoute } from '@tanstack/react-router'
import { analyzeComfyWorkflow } from '../server/images.server'
import { err, errMsg, json, readJson } from '../server/http.server'

export const Route = createFileRoute('/api/images/comfy/analyze')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const b = await readJson(request)
        try {
          return json(analyzeComfyWorkflow(b.workflow))
        } catch (e) {
          return err(400, errMsg(e))
        }
      },
    },
  },
})
