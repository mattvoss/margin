import { createFileRoute } from '@tanstack/react-router'
import { readWorkspaceFile, requestWorkspaceDir } from '../server/storage.server'
import { err, errMsg, json } from '../server/http.server'

export const Route = createFileRoute('/api/workspace/styles')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const ws = await requestWorkspaceDir(request)
          const manifest = await readWorkspaceFile('styles/STYLES.md', ws).catch(() => '')
          const styles = manifest
            .split('\n')
            .map((l) => l.trim().replace(/^[-*]\s+/, ''))
            .filter(Boolean)
            .filter((l) => !l.toLowerCase().endsWith('.md'))
            .map((l) => {
              const m = l.match(/^(\S+)\s*[\u2014\u2013-]\s*(.*)$/)
              return m ? { name: m[1].toLowerCase(), description: m[2] ?? '' } : { name: l.toLowerCase(), description: '' }
            })
          return json(styles)
        } catch (e) {
          return err(500, errMsg(e))
        }
      },
    },
  },
})
