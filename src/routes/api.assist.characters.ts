import { createFileRoute } from '@tanstack/react-router'
import { err, errMsg, json, readJson } from '../server/http.server'
import { requestSettings, requestWorkspaceDir, readWorkspaceFile } from '../server/storage.server'
import {
  CharacterExtractionError,
  CharacterNotFoundError,
  CharacterStateError,
  CharacterValidationError,
  applyManualAction,
  extractAndMergeCharacters,
  readCharacterState,
  writeCharacterState,
  type ExtractMode,
} from '../server/characters.server'

function characterErrorResponse(error: unknown): Response {
  const message = errMsg(error)
  if (error instanceof CharacterNotFoundError) return err(404, message)
  if (error instanceof CharacterValidationError) return err(400, message)
  if (error instanceof CharacterStateError) return err(500, message)
  if (error instanceof CharacterExtractionError) return err(502, message)
  if (message.includes('No endpoint')) return err(400, message)
  if (message.includes('File not found') || message.includes('Invalid path')) {
    return err(400, message)
  }
  return err(500, message)
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  return typeof value === 'string' ? value : ''
}

export const Route = createFileRoute('/api/assist/characters')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const workspaceDir = await requestWorkspaceDir(request)
          const state = await readCharacterState(workspaceDir)
          return json({ state })
        } catch (error) {
          return characterErrorResponse(error)
        }
      },

      POST: async ({ request }) => {
        try {
          const body = await readJson(request)
          const workspaceDir = await requestWorkspaceDir(request, body)
          const settings = await requestSettings(request, body)

          const mode: ExtractMode = body.mode === 'rescan' ? 'rescan' : 'passage'
          const filePath = stringField(body, 'file_path').trim() || null
          const sessionId = stringField(body, 'session_id').trim() || null
          const generated = stringField(body, 'generated_text')
          const hasDocumentText = typeof body.document_text === 'string'
          let text = stringField(body, 'document_text')

          if (mode === 'rescan') {
            // An explicitly supplied document_text is the open editor buffer,
            // even when it is empty — do not silently fall back to a stale
            // on-disk copy in that case.
            if (!hasDocumentText && filePath) {
              text = await readWorkspaceFile(filePath, workspaceDir)
            }
            if (!text.trim()) text = generated
          } else {
            text = generated || text
          }

          if (!text.trim()) return err(400, 'No text to scan.')

          const prior = await readCharacterState(workspaceDir)
          const state = await extractAndMergeCharacters({
            mode,
            text,
            filePath,
            sessionId,
            prior,
            settings,
            signal: request.signal,
          })
          await writeCharacterState(workspaceDir, state)
          return json({ state })
        } catch (error) {
          return characterErrorResponse(error)
        }
      },

      PATCH: async ({ request }) => {
        try {
          const body = await readJson(request)
          const workspaceDir = await requestWorkspaceDir(request, body)
          const state = await readCharacterState(workspaceDir)
          const next = applyManualAction(state, body)
          await writeCharacterState(workspaceDir, next)
          return json({ state: next })
        } catch (error) {
          return characterErrorResponse(error)
        }
      },
    },
  },
})
