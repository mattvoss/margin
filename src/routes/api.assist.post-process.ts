import { createFileRoute } from '@tanstack/react-router'
import {
  pickWriterMaxTokens,
  type AnchorContext,
} from '../server/assist.server'
import { readCharacterState } from '../server/characters.server'
import { err, errMsg, json, readJson } from '../server/http.server'
import { runSinglePostProcessPass } from '../server/post-process.server'
import {
  readWorkspaceFile,
  requestSettings,
  requestWorkspaceDir,
} from '../server/storage.server'
import { formatCharacterPrompt } from '../lib/characters'

const MAX_MANUAL_TEXT_CHARS = 200_000

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readAvailableFiles(
  value: unknown,
): Array<{ name: string; path: string }> {
  if (!Array.isArray(value)) return []
  const files: Array<{ name: string; path: string }> = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const name = asString(record.name).trim()
    const path = asString(record.path).trim()
    if (name && path) files.push({ name, path })
  }
  return files
}

/**
 * Best-effort document window for a block that is not the editor's current
 * selection. Explicit before/after text wins; otherwise locate the block in the
 * current editor content. When neither is available, document context is
 * omitted rather than pointing at an unrelated paragraph.
 */
function buildManualAnchor(
  text: string,
  content: string,
  textBefore: string,
  textAfter: string,
): AnchorContext | null {
  if (textBefore || textAfter) {
    return {
      paragraphBefore: textBefore,
      targetParagraph: text,
      paragraphAfter: textAfter,
      targetIdx: 0,
      replace: true,
    }
  }
  if (!content || !text || !content.includes(text)) return null

  const index = content.indexOf(text)
  const beforeParas = content
    .slice(0, index)
    .split('\n\n')
    .filter((paragraph) => paragraph.trim().length > 0)
  const afterParas = content
    .slice(index + text.length)
    .split('\n\n')
    .filter((paragraph) => paragraph.trim().length > 0)

  return {
    paragraphBefore: beforeParas[beforeParas.length - 1] ?? '',
    targetParagraph: text,
    paragraphAfter: afterParas[0] ?? '',
    targetIdx: beforeParas.length,
    replace: true,
  }
}

export const Route = createFileRoute('/api/assist/post-process')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readJson(request)
        const passId = asString(body.pass_id).trim()
        const text = asString(body.text)
        if (!passId) return err(400, 'Missing pass_id')
        if (!text.trim()) return err(400, 'Missing text')
        if (text.length > MAX_MANUAL_TEXT_CHARS) {
          return err(413, 'Text is too large for a one-off pass')
        }

        try {
          const settings = await requestSettings(request)
          const workspaceDir = await requestWorkspaceDir(request)
          const characterMessage = await readCharacterState(workspaceDir)
            .then(formatCharacterPrompt)
            .catch(() => null)
          const content = asString(body.content)
          const anchor = buildManualAnchor(
            text,
            content,
            asString(body.text_before),
            asString(body.text_after),
          )
          const result = await runSinglePostProcessPass({
            settings,
            workspaceDir,
            sessionId: asString(body.session_id) || null,
            characterMessage,
            availableFiles: readAvailableFiles(body.available_files),
            readFile: (path) => readWorkspaceFile(path, workspaceDir).catch(() => null),
            defaultMaxTokens: pickWriterMaxTokens(settings),
            anchor,
            text,
            passId,
            signal: request.signal,
          })

          return json({
            output: result.text,
            original: result.original,
            skipped: result.skipped,
            reason: result.reason ?? null,
            pass: result.passes[0] ?? null,
          })
        } catch (error) {
          return err(500, errMsg(error))
        }
      },
    },
  },
})
