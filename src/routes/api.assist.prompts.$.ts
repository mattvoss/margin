import { createFileRoute } from '@tanstack/react-router'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dec, err, errMsg, json, readJson, resolvePrompts } from '../server/http.server'

export const Route = createFileRoute('/api/assist/prompts/$')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const name = dec(params._splat ?? '')
        if (!name || name.includes('/') || name.includes('..')) return err(404, 'Prompt file not found')
        try {
          return json({ content: await readFile(join(await resolvePrompts(), name), 'utf-8') })
        } catch {
          return err(404, 'Prompt file not found')
        }
      },
      POST: async ({ request, params }) => {
        const name = dec(params._splat ?? '')
        const b = await readJson(request)
        if (!name || name.includes('/') || name.includes('..')) return err(400, 'Invalid prompt file')
        try {
          const dir = await resolvePrompts()
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, name), String(b.content ?? ''), 'utf-8')
          return json({ status: 'success' })
        } catch (e) {
          return err(500, `Failed to save prompt: ${errMsg(e)}`)
        }
      },
    },
  },
})
