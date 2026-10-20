import { createFileRoute } from '@tanstack/react-router'
import { dec, err, errMsg, json, readJson } from '../server/http.server'
import {
  PromptNotFoundError,
  listPrompts,
  readPrompt,
  writePrompt,
} from '../server/prompts.server'

export const Route = createFileRoute('/api/assist/prompts/$')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const name = dec(params._splat ?? '')
        // NOTE: the splat child matches the bare path too (empty splat), and
        // shadows the parent collection route — serve the listing here.
        if (!name) {
          try {
            return json(await listPrompts())
          } catch (e) {
            return err(500, `Failed to list prompts: ${errMsg(e)}`)
          }
        }
        try {
          return json({ content: await readPrompt(name) })
        } catch (e) {
          if (e instanceof PromptNotFoundError) {
            console.error(`[prompts] not found: ${name} (tried ${e.attempts.join(', ') || 'no candidates'})`)
            return err(404, 'Prompt file not found')
          }
          console.error(`[prompts] failed to read ${name}: ${errMsg(e)}`)
          return err(500, `Failed to read prompt: ${errMsg(e)}`)
        }
      },
      POST: async ({ request, params }) => {
        const name = dec(params._splat ?? '')
        const b = await readJson(request)
        try {
          await writePrompt(name, String(b.content ?? ''))
          return json({ status: 'success' })
        } catch (e) {
          if (e instanceof PromptNotFoundError) return err(400, 'Invalid prompt file')
          return err(500, `Failed to save prompt: ${errMsg(e)}`)
        }
      },
    },
  },
})
