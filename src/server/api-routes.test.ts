// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

process.env.MARGIN_TEST_DIR = mkdtempSync(join(tmpdir(), 'margin-api-test-'))

import { Route as SettingsRoute } from '../routes/api.settings'
import { Route as EnvDefaultRoute } from '../routes/api.settings.env-default'
import { Route as FilesRoute } from '../routes/api.workspace.files'
import { Route as FilesSplatRoute } from '../routes/api.workspace.files.$'
import { Route as FoldersSplatRoute } from '../routes/api.workspace.folders.$'
import { Route as StatsRoute } from '../routes/api.workspace.stats'
import { Route as GitStatusRoute } from '../routes/api.workspace.git-status'
import { Route as BrowseRoute } from '../routes/api.workspace.browse'
import { Route as ProfilesRoute } from '../routes/api.workspace.profiles'
import { Route as ProfilesIdRoute } from '../routes/api.workspace.profiles.$id'
import { Route as LinkRoute } from '../routes/api.workspace.link'
import { Route as GitTrackedRoute } from '../routes/api.workspace.git-tracked'
import { Route as CreateRoute } from '../routes/api.workspace.create'
import { Route as MediaRoute } from '../routes/api.workspace.media'
import { Route as MediaSplatRoute } from '../routes/api.workspace.media.$'
import { Route as MediaFromUrlRoute } from '../routes/api.workspace.media.from-url'
import { Route as ImagesStylesRoute } from '../routes/api.images.styles'
import { Route as ImagesLogsRoute } from '../routes/api.images.logs'
import { Route as ImagesGenerateRoute } from '../routes/api.images.generate'
import { Route as ImagesComfyRoute } from '../routes/api.images.comfy.analyze'
import { Route as ImagesRevealRoute } from '../routes/api.images.reveal'
import { Route as HarnessesRoute } from '../routes/api.harnesses'
import { Route as HarnessModelsRoute } from '../routes/api.harnesses.$id.models'
import { Route as PromptsRoute } from '../routes/api.assist.prompts'
import { Route as PromptsSplatRoute } from '../routes/api.assist.prompts.$'
import { Route as AssistSimpleRoute } from '../routes/api.assist.simple'
import { Route as AssistPostProcessRoute } from '../routes/api.assist.post-process'
import { Route as AssistSimpleLogsRoute } from '../routes/api.assist.simple.logs'
import { Route as AssistStopRoute } from '../routes/api.assist.simple.stop.$'
import { Route as AssistSessionRoute } from '../routes/api.assist.simple.session.$'
import { defaultWorkspaceDir } from './env.server.js'
import {
  clientSettingsFromRequest,
  requestSettings,
  requestWorkspaceDir,
} from './storage.server'

function handlersOf(route: unknown): Record<string, (ctx: never) => Promise<Response>> {
  return (route as { options: { server: { handlers: Record<string, (ctx: never) => Promise<Response>> } } }).options
    .server.handlers
}

function req(path: string, method = 'GET', body?: unknown): Request {
  const init: RequestInit = { method }
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return new Request(`http://localhost/api/${path}`, init)
}

/** Minimal OpenAI-compatible SSE response for agent orchestration tests. */
function sseResponse(chunks: unknown[]): Response {
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
    'data: [DONE]\n\n'
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

function parseSseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
}

/** Minimal non-streaming OpenAI-compatible completion. */
function completionResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'assist-mock',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function toolCallResponse(name: string, args: Record<string, unknown>, id: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'assist-mock',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

async function invoke(
  route: unknown,
  method: string,
  path: string,
  body?: unknown,
  params: Record<string, string> = {},
): Promise<{ status: number; data: unknown; res: Response }> {
  const h = handlersOf(route)[method]
  if (!h) throw new Error(`no ${method} handler for ${path}`)
  const res = await h({ request: req(path, method, body), params } as never)
  const data = await res.json().catch(() => null)
  return { status: res.status, data, res }
}

describe('settings', () => {
  it('returns defaults and persists updates', async () => {
    const g = await invoke(SettingsRoute, 'GET', 'settings/')
    expect(g.status).toBe(200)
    expect((g.data as { theme: string }).theme).toBe('light')
    const p = await invoke(SettingsRoute, 'PATCH', 'settings/', { theme: 'dark' })
    expect((p.data as { theme: string }).theme).toBe('dark')
    const g2 = await invoke(SettingsRoute, 'GET', 'settings/')
    expect((g2.data as { theme: string }).theme).toBe('dark')
    await invoke(SettingsRoute, 'PATCH', 'settings/', { theme: 'light' })
  })

  it('exposes env defaults', async () => {
    const r = await invoke(EnvDefaultRoute, 'GET', 'settings/env-default')
    expect(r.status).toBe(200)
    expect(r.data).toHaveProperty('base_url')
  })
})

describe('workspace files', () => {
  it('CRUD round-trip', async () => {
    const c = await invoke(FilesRoute, 'POST', 'workspace/files', { folder: 'chapters', name: 't1', content: '# T' })
    expect(c.status).toBe(200)
    expect((c.data as { path: string }).path).toBe('chapters/t1.md')
    const list = await invoke(FilesRoute, 'GET', 'workspace/files')
    expect(((list.data as { path: string }[]).map((f) => f.path))).toContain('chapters/t1.md')
    const read = await invoke(FilesSplatRoute, 'GET', 'workspace/files/chapters%2Ft1.md', undefined, {
      _splat: 'chapters/t1.md',
    })
    expect((read.data as { content: string }).content).toBe('# T')
    const put = await invoke(FilesSplatRoute, 'PUT', 'workspace/files/chapters%2Ft1.md', { content: '# T2' }, {
      _splat: 'chapters/t1.md',
    })
    expect((put.data as { success: boolean }).success).toBe(true)
    const ren = await invoke(FilesSplatRoute, 'PATCH', 'workspace/files/chapters%2Ft1.md', { name: 't2.md' }, {
      _splat: 'chapters/t1.md',
    })
    expect((ren.data as { path: string }).path).toBe('chapters/t2.md')
    const del = await invoke(FilesSplatRoute, 'DELETE', 'workspace/files/chapters%2Ft2.md', undefined, {
      _splat: 'chapters/t2.md',
    })
    expect((del.data as { success: boolean }).success).toBe(true)
    const missing = await invoke(FilesSplatRoute, 'GET', 'workspace/files/nope.md', undefined, { _splat: 'nope.md' })
    expect(missing.status).toBe(404)
  })

  it('rejects traversal', async () => {
    const r = await invoke(FilesSplatRoute, 'GET', 'workspace/files/%2E%2E%2Fsecret', undefined, {
      _splat: '../secret',
    })
    expect(r.status).toBe(404)
    expect(String((r.data as { detail: string }).detail)).toMatch(/invalid path|not found/i)
  })

  it('renames and deletes folders', async () => {
    await invoke(FilesRoute, 'POST', 'workspace/files', { folder: 'scratch', name: 'a', content: 'x' })
    const ren = await invoke(FoldersSplatRoute, 'PATCH', 'workspace/folders/scratch', { name: 'scratch2' }, {
      _splat: 'scratch',
    })
    expect(ren.status).toBe(200)
    const del = await invoke(FoldersSplatRoute, 'DELETE', 'workspace/folders/scratch2', undefined, {
      _splat: 'scratch2',
    })
    expect((del.data as { success: boolean }).success).toBe(true)
  })

  it('serves stats, git-status, browse', async () => {
    const stats = await invoke(StatsRoute, 'GET', 'workspace/stats')
    expect((stats.data as { success: boolean }).success).toBe(true)
    expect((stats.data as { stats: object }).stats).toHaveProperty('markdown_files')
    const gs = await invoke(GitStatusRoute, 'GET', 'workspace/git-status')
    expect(gs.data).toHaveProperty('available')
    const br = await invoke(
      BrowseRoute,
      'GET',
      `workspace/browse?path=${encodeURIComponent(process.env.MARGIN_TEST_DIR!)}`,
    )
    expect([200, 400, 403, 404]).toContain(br.status)
  })
})

describe('profiles and workspaces', () => {
  it('upsert/rename/forget profile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'margin-ws-'))
    const up = await invoke(ProfilesRoute, 'POST', 'workspace/profiles', { path: dir, name: 'Tmp' })
    expect((up.data as { success: boolean }).success).toBe(true)
    const id = (up.data as { profile: { id: string } }).profile.id
    const ren = await invoke(ProfilesIdRoute, 'PATCH', `workspace/profiles/${id}`, { name: 'Tmp2' }, { id })
    expect((ren.data as { profile: { name: string } }).profile.name).toBe('Tmp2')
    const del = await invoke(ProfilesIdRoute, 'DELETE', `workspace/profiles/${id}?mode=forget`, undefined, { id })
    expect((del.data as { success: boolean }).success).toBe(true)
  })

  it('links a workspace and inits git state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'margin-link-'))
    const link = await invoke(LinkRoute, 'POST', 'workspace/link', { path: dir })
    expect((link.data as { success: boolean }).success).toBe(true)
    const tracked = await invoke(GitTrackedRoute, 'GET', `workspace/git-tracked?path=${encodeURIComponent(dir)}`)
    expect((tracked.data as { tracked: boolean }).tracked).toBe(false)
  })

  it('creates a workspace with scaffold', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'margin-parent-'))
    const c = await invoke(CreateRoute, 'POST', 'workspace/create', {
      parent_path: parent,
      name: 'novel',
      set_as_active: false,
    })
    expect(c.status).toBe(200)
    expect((c.data as { path: string }).path).toContain('novel')
  })
})

describe('media', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1])

  it('uploads and serves an image', async () => {
    const form = new FormData()
    form.append('file', new File([png], 'cover.png', { type: 'image/png' }))
    const h = handlersOf(MediaRoute).POST
    const res = await h({ request: req('workspace/media', 'POST', form) } as never)
    expect(res.status).toBe(200)
    const saved = (await res.json()) as { path: string }
    expect(saved.path).toMatch(/^assets\//)
    const get = await handlersOf(MediaSplatRoute).GET({
      request: req(`workspace/media/${saved.path}`),
      params: { _splat: saved.path },
    } as never)
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toContain('image/png')
  })

  it('rejects bad from-url', async () => {
    const r = await invoke(MediaFromUrlRoute, 'POST', 'workspace/media/from-url', { url: 'ftp://x/y.png' })
    expect(r.status).toBe(400)
  })
})

describe('images', () => {
  it('lists styles and empty logs', async () => {
    const s = await invoke(ImagesStylesRoute, 'GET', 'images/styles')
    expect(((s.data as { styles: unknown[] }).styles.length)).toBeGreaterThan(0)
    const l = await invoke(ImagesLogsRoute, 'GET', 'images/logs')
    expect((l.data as { logs: unknown[] }).logs).toEqual([])
  })

  it('rejects empty generate and bad workflow', async () => {
    const g = await invoke(ImagesGenerateRoute, 'POST', 'images/generate', { prompt: '' })
    expect(g.status).toBe(400)
    const a = await invoke(ImagesComfyRoute, 'POST', 'images/comfy/analyze', { workflow: { nope: 1 } })
    expect(a.status).toBe(400)
  })

  it('reveal returns a path without spawning', async () => {
    const r = await invoke(ImagesRevealRoute, 'POST', 'images/reveal', {})
    expect((r.data as { success: boolean }).success).toBe(true)
  })
})

describe('harnesses', () => {
  it('lists harnesses with installed flags', async () => {
    const r = await invoke(HarnessesRoute, 'GET', 'harnesses')
    expect(Array.isArray((r.data as { harnesses: unknown[] }).harnesses)).toBe(true)
    expect((r.data as { harnesses: Record<string, unknown>[] }).harnesses[0]).toHaveProperty('installed')
  })

  it('404s unknown harness models', async () => {
    const r = await invoke(HarnessModelsRoute, 'GET', 'harnesses/nope/models', undefined, { id: 'nope' })
    expect(r.status).toBe(404)
  })

  it('lists opencode models from the service, degrading to manual entry', async () => {
    const r = await invoke(HarnessModelsRoute, 'GET', 'harnesses/opencode/models', undefined, { id: 'opencode' })
    expect(r.status).toBe(200)
    expect(Array.isArray((r.data as { models: unknown[] }).models)).toBe(true)
    expect((r.data as { manual: boolean }).manual).toBe(
      (r.data as { models: unknown[] }).models.length === 0,
    )
  })

  it('lists pi models from the SDK, degrading to manual entry', async () => {
    const r = await invoke(HarnessModelsRoute, 'GET', 'harnesses/pi/models', undefined, { id: 'pi' })
    expect(r.status).toBe(200)
    expect(Array.isArray((r.data as { models: unknown[] }).models)).toBe(true)
    expect((r.data as { manual: boolean }).manual).toBe(
      (r.data as { models: unknown[] }).models.length === 0,
    )
  })

  it('reports pi among the harnesses without needing an executable', async () => {
    const r = await invoke(HarnessesRoute, 'GET', 'harnesses')
    const pi = (r.data as { harnesses: { id: string; name: string; installed: boolean }[] }).harnesses.find(
      (h) => h.id === 'pi',
    )
    expect(pi).toBeDefined()
    expect(pi!.name).toBe('Pi')
    expect(typeof pi!.installed).toBe('boolean')
  })
})

describe('assist', () => {
  it('lists and reads prompts', async () => {
    const l = await invoke(PromptsRoute, 'GET', 'assist/prompts')
    expect(l.status).toBe(200)
    expect(((l.data as { name: string }[]).length)).toBeGreaterThan(0)
    const one = await invoke(PromptsSplatRoute, 'GET', `assist/prompts/${(l.data as { name: string }[])[0].name}`, undefined, {
      _splat: (l.data as { name: string }[])[0].name,
    })
    expect(typeof (one.data as { content: string }).content).toBe('string')
  })

  it('lists prompts through the splat child for the bare path', async () => {
    // The `$` child shadows the parent route at runtime; empty splat must list.
    const l = await invoke(PromptsSplatRoute, 'GET', 'assist/prompts', undefined, { _splat: '' })
    expect(l.status).toBe(200)
    expect(Array.isArray(l.data)).toBe(true)
    expect((l.data as { name: string }[]).map((p) => p.name)).toContain('simple-writer.md')
  })

  it('rejects empty message', async () => {
    const r = await invoke(AssistSimpleRoute, 'POST', 'assist/simple', { mode: 'chat', message: '  ' })
    expect(r.status).toBe(400)
  })

  it('validates one-off post-processing requests', async () => {
    const missingPass = await invoke(AssistPostProcessRoute, 'POST', 'assist/post-process', {
      text: 'some text',
    })
    expect(missingPass.status).toBe(400)

    const missingText = await invoke(AssistPostProcessRoute, 'POST', 'assist/post-process', {
      pass_id: 'starter_fix_slop',
      text: '  ',
    })
    expect(missingText.status).toBe(400)
  })

  it('streams an error event when no LLM is reachable', async () => {
    const res = await handlersOf(AssistSimpleRoute).POST({
      request: req('assist/simple', 'POST', { mode: 'chat', message: 'hi', session_id: 't1', harness: 'none' }),
    } as never)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('"status":"generating"')
    expect(text).toContain('"status":"error"')
  })

  it('pauses on ask_user, then resumes with the user tool result before starting the plan', async () => {
    vi.stubEnv('LM_STUDIO_BASE_URL', 'http://assist-mock.local/v1')
    vi.stubEnv('LM_STUDIO_MODEL', 'assist-mock')
    const freeformAnswer = 'They reconcile with a quiet apology after sunrise.'
    let clarificationCalls = 0
    let stageCalls = 0
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role?: string; content?: unknown }>
        tools?: Array<{ function?: { name?: string } }>
      }
      const isClarifier = body.tools?.some((candidate) =>
        candidate.function?.name === 'ask_user',
      )
      if (isClarifier) {
        clarificationCalls++
        const messages = JSON.stringify(body.messages ?? [])
        if (clarificationCalls === 1) {
          expect(messages).toContain('Have the characters reconcile after the argument.')
          expect(messages).toContain('The chapter ends at the station.')
          return toolCallResponse('ask_user', {
            questions: [{
              id: 'resolution',
              question: 'How should the argument resolve?',
              options: ['A quiet apology', 'A tense interruption'],
            }],
          }, 'call-ask-user')
        }
        expect(messages).toContain('"role":"tool"')
        if (clarificationCalls === 2) {
          expect(messages).toContain(freeformAnswer)
          return toolCallResponse('ask_user', {
            questions: [{
              id: 'pacing',
              question: 'How quickly should they reconcile?',
              options: ['Immediately', 'Over a few days'],
            }],
          }, 'call-ask-pacing')
        }
        expect(messages).toContain('Over a few days')
        return toolCallResponse('proceed_to_plan', {}, 'call-proceed')
      }

      stageCalls++
      return sseResponse([
        {
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: `Stage ${stageCalls} notes.` },
            finish_reason: null,
          }],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ])
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const initial = await handlersOf(AssistSimpleRoute).POST({
        request: req('assist/simple', 'POST', {
          mode: 'write',
          message: 'Have the characters reconcile after the argument.',
          content: 'The chapter ends at the station.',
          session_id: 'write-clarification-test',
          harness: 'none',
        }),
      } as never)
      const initialEvents = parseSseEvents(await initial.text())
      const questionnaire = initialEvents.find((event) => event.status === 'write_questionnaire')

      expect(questionnaire).toMatchObject({
        questions: [
          {
            id: 'resolution',
            question: 'How should the argument resolve?',
            options: ['A quiet apology', 'A tense interruption'],
          },
        ],
      })
      expect(questionnaire?.clarification_id).toEqual(expect.any(String))
      expect(initialEvents.some((event) => event.status === 'write_started')).toBe(false)
      expect(stageCalls).toBe(0)

      const invalidResume = await handlersOf(AssistSimpleRoute).POST({
        request: req('assist/simple', 'POST', {
          mode: 'write',
          message: 'Have the characters reconcile after the argument.',
          content: 'The chapter ends at the station.',
          session_id: 'write-clarification-test',
          harness: 'none',
          clarification_id: 'not-the-pending-id',
          clarification_answers: { resolution: 'A quiet apology' },
        }),
      } as never)
      const invalidEvents = parseSseEvents(await invalidResume.text())
      expect(invalidEvents.find((event) => event.status === 'error')?.detail).toContain('expired')
      expect(clarificationCalls).toBe(1)

      const invalidAnswers = await handlersOf(AssistSimpleRoute).POST({
        request: req('assist/simple', 'POST', {
          mode: 'write',
          message: 'Have the characters reconcile after the argument.',
          content: 'The chapter ends at the station.',
          session_id: 'write-clarification-test',
          harness: 'none',
          clarification_id: questionnaire?.clarification_id,
          clarification_answers: { unknown: 'A quiet apology' },
        }),
      } as never)
      const invalidAnswerEvents = parseSseEvents(await invalidAnswers.text())
      expect(invalidAnswerEvents.find((event) => event.status === 'error')?.detail).toContain('do not match')
      expect(clarificationCalls).toBe(1)

      const resumed = await handlersOf(AssistSimpleRoute).POST({
        request: req('assist/simple', 'POST', {
          mode: 'write',
          message: 'Have the characters reconcile after the argument.',
          content: 'The chapter ends at the station.',
          session_id: 'write-clarification-test',
          harness: 'none',
          clarification_id: questionnaire?.clarification_id,
          clarification_answers: { resolution: freeformAnswer },
        }),
      } as never)
      const resumedEvents = parseSseEvents(await resumed.text())
      const nextQuestionnaire = resumedEvents.find((event) => event.status === 'write_questionnaire')

      expect(nextQuestionnaire).toMatchObject({
        questions: [{
          id: 'pacing',
          question: 'How quickly should they reconcile?',
          options: ['Immediately', 'Over a few days'],
        }],
      })
      expect(nextQuestionnaire?.clarification_id).toEqual(expect.any(String))
      expect(resumedEvents.some((event) => event.status === 'write_started')).toBe(false)
      expect(stageCalls).toBe(0)

      const finalResume = await handlersOf(AssistSimpleRoute).POST({
        request: req('assist/simple', 'POST', {
          mode: 'write',
          message: 'Have the characters reconcile after the argument.',
          content: 'The chapter ends at the station.',
          session_id: 'write-clarification-test',
          harness: 'none',
          clarification_id: nextQuestionnaire?.clarification_id,
          clarification_answers: { pacing: 'Over a few days' },
        }),
      } as never)
      const finalEvents = parseSseEvents(await finalResume.text())

      expect(finalEvents.some((event) => event.status === 'write_questionnaire')).toBe(false)
      expect(finalEvents.some((event) => event.status === 'write_started')).toBe(true)
      expect(finalEvents.find((event) => event.status === 'write_completed')).toMatchObject({
        output: 'Stage 6 notes.',
      })
      expect(clarificationCalls).toBe(3)
      expect(stageCalls).toBe(6)
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it('starts the write plan directly when the clarifying agent proceeds', async () => {
    vi.stubEnv('LM_STUDIO_BASE_URL', 'http://assist-mock.local/v1')
    vi.stubEnv('LM_STUDIO_MODEL', 'assist-mock')
    let stageCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        tools?: Array<{ function?: { name?: string } }>
      }
      if (body.tools?.some((candidate) => candidate.function?.name === 'ask_user')) {
        return toolCallResponse('proceed_to_plan', {}, 'call-proceed-directly')
      }
      stageCalls++
      return sseResponse([
        {
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: `Stage ${stageCalls} notes.` },
            finish_reason: null,
          }],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ])
    }))

    try {
      const response = await handlersOf(AssistSimpleRoute).POST({
        request: req('assist/simple', 'POST', {
          mode: 'write',
          message: 'Continue the established scene with the same point of view and tense.',
          content: 'The scene already establishes the characters, conflict, and ending.',
          session_id: 'write-clear-request-test',
          harness: 'none',
        }),
      } as never)
      const events = parseSseEvents(await response.text())

      expect(events.some((event) => event.status === 'write_questionnaire')).toBe(false)
      expect(events.some((event) => event.status === 'write_started')).toBe(true)
      expect(stageCalls).toBe(6)
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it('orchestrates chat through the dispatcher and chat subagent', async () => {
    vi.stubEnv('LM_STUDIO_BASE_URL', 'http://assist-mock.local/v1')
    vi.stubEnv('LM_STUDIO_MODEL', 'assist-mock')
    const calls: string[] = []
    let orchestrationStep = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown[] }
        if (Array.isArray(body.tools) && body.tools.length > 0) {
          const names = ['write_chat', 'post_process', 'finish']
          const name = names[orchestrationStep++]
          calls.push(name)
          return sseResponse([
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_${orchestrationStep}`,
                        type: 'function',
                        function: { name, arguments: '{}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ])
        }
        calls.push('chat')
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'Hello <thi' },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: { content: 'nk>private reasoning</think>from the chat agent.' },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ])
      }),
    )

    try {
      const res = await handlersOf(AssistSimpleRoute).POST({
        request: req('assist/simple', 'POST', {
          mode: 'chat',
          message: 'hi',
          session_id: 'agent-test',
          harness: 'none',
        }),
      } as never)
      expect(res.headers.get('x-accel-buffering')).toBe('no')
      expect(res.headers.get('cache-control')).toContain('no-transform')
      const text = await res.text()
      const events = parseSseEvents(text)
      expect(
        events
          .filter((event) => event.status === 'chunk')
          .map((event) => event.chunk)
          .join(''),
      ).toBe('Hello from the chat agent.')
      expect(
        events
          .filter((event) => event.status === 'thinking_chunk')
          .map((event) => event.chunk)
          .join(''),
      ).toBe('private reasoning')
      expect(text).toContain('"status":"chat","output":"Hello from the chat agent."')
      expect(calls).toEqual(['write_chat', 'chat', 'post_process', 'finish'])
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it('orchestrates edit through planning, editing, and post-processing', async () => {
    vi.stubEnv('LM_STUDIO_BASE_URL', 'http://assist-mock.local/v1')
    vi.stubEnv('LM_STUDIO_MODEL', 'assist-mock')
    const calls: string[] = []
    let orchestrationStep = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          tools?: unknown[]
          stream?: boolean
        }
        if (Array.isArray(body.tools) && body.tools.length > 0) {
          const names =
            orchestrationStep++ === 0
              ? ['plan_edit', 'write_edit', 'post_process']
              : ['finish']
          calls.push(...names)
          return sseResponse([
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: names.map((name, index) => ({
                      index,
                      id: `call_${orchestrationStep}_${index}`,
                      type: 'function',
                      function: { name, arguments: '{}' },
                    })),
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ])
        }
        if (body.stream !== true) {
          calls.push('planner')
          return completionResponse(
            JSON.stringify({ context_needed: [], refined_query: 'Make it tense.' }),
          )
        }
        calls.push('writer')
        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'A tenser line.' },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 14, completion_tokens: 4, total_tokens: 18 },
          },
        ])
      }),
    )

    try {
      const res = await handlersOf(AssistSimpleRoute).POST({
        request: req('assist/simple', 'POST', {
          mode: 'edit',
          message: 'Make it tense.',
          content: 'Line one.\n\nLine two.',
          cursor_paragraph_text: 'Line two.',
          session_id: 'agent-edit-test',
          harness: 'none',
          available_files: [],
        }),
      } as never)
      const text = await res.text()
      const events = parseSseEvents(text)
      expect(text).toContain('"status":"planning"')
      expect(text).toContain('"status":"context_resolved"')
      expect(text).toContain('"status":"generating"')
      expect(
        events
          .filter((event) => event.status === 'chunk')
          .map((event) => event.chunk)
          .join(''),
      ).toBe('A tenser line.')
      expect(text).toContain('"status":"applied","output":"A tenser line."')
      expect(calls.filter((call) => call === 'plan_edit')).toHaveLength(1)
      expect(calls.filter((call) => call === 'planner')).toHaveLength(1)
      expect(calls.filter((call) => call === 'write_edit')).toHaveLength(1)
      expect(calls.filter((call) => call === 'writer')).toHaveLength(1)
      expect(calls.filter((call) => call === 'post_process')).toHaveLength(1)
      expect(calls.filter((call) => call === 'finish')).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it('stop and session delete are idempotent', async () => {
    const s = await invoke(AssistStopRoute, 'POST', 'assist/simple/stop/missing', {}, { _splat: 'missing' })
    expect((s.data as { status: string }).status).toBe('ok')
    const d = await invoke(AssistSessionRoute, 'DELETE', 'assist/simple/session/missing', undefined, {
      _splat: 'missing',
    })
    expect((d.data as { status: string }).status).toBe('ok')
  })

  it('reads simple logs', async () => {
    const l = await invoke(AssistSimpleLogsRoute, 'GET', 'assist/simple/logs')
    expect(l.status).toBe(200)
    expect(Array.isArray(l.data)).toBe(true)
  })

  it('filters simple logs by session and mode', async () => {
    const ws = await requestWorkspaceDir(new Request('http://localhost/x'))
    const dir = join(ws, 'outputs', 'ai_logs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'filter-session.json'),
      JSON.stringify([
        { id: '1', timestamp: '2026-01-01T00:00:00.000Z', mode: 'chat', session_id: 'filter-session' },
        { id: '2', timestamp: '2026-01-02T00:00:00.000Z', mode: 'planner', session_id: 'filter-session' },
        { id: '3', timestamp: '2026-01-03T00:00:00.000Z', mode: 'planner', session_id: 'other' },
      ]),
      'utf-8',
    )

    const planner = await invoke(
      AssistSimpleLogsRoute,
      'GET',
      'assist/simple/logs?session_id=filter-session&mode=planner',
    )
    expect((planner.data as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['2'])

    const session = await invoke(AssistSimpleLogsRoute, 'GET', 'assist/simple/logs?session_id=filter-session')
    expect((session.data as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['1', '2'])
  })
})

describe('per-client settings (localStorage keys on the request)', () => {
  const linked = mkdtempSync(join(tmpdir(), 'margin-client-ws-'))
  const clientHeader = (settings: Record<string, unknown>) => ({
    'x-margin-client-settings': encodeURIComponent(JSON.stringify(settings)),
  })

  it('reads the header and the img-src query fallback', () => {
    const h = new Request('http://localhost/x', {
      headers: clientHeader({ linked_workspace_dir: linked, theme: 'dark', endpoints: { evil: {} } }),
    })
    expect(clientSettingsFromRequest(h)).toEqual({
      linked_workspace_dir: linked,
      theme: 'dark',
      endpoints: { evil: {} },
    })
    const q = new Request(`http://localhost/api/workspace/media/x.png?linked_workspace_dir=${encodeURIComponent(linked)}`)
    expect(clientSettingsFromRequest(q)?.linked_workspace_dir).toBe(linked)
  })

  it('overlays only browser-owned keys (allowlist)', async () => {
    const h = new Request('http://localhost/x', {
      headers: clientHeader({ theme: 'dark', endpoints: { evil: {} as Record<string, unknown> } }),
    })
    const settings = await requestSettings(h)
    expect(settings.theme).toBe('dark')
    expect(settings.endpoints).toEqual({})
  })

  it('prefers the client workspace, falling back to settings.json', async () => {
    // Baseline: clear any linked dir other tests left in settings.json so the
    // unconfigured-caller fallback is deterministic.
    await invoke(SettingsRoute, 'PATCH', 'settings/', { linked_workspace_dir: null })
    // No client on the request -> the server's settings.json decides.
    expect(await requestWorkspaceDir(new Request('http://localhost/x'))).toBe(defaultWorkspaceDir())
    // A browser's linked dir wins and gets its scaffolds created.
    const resolved = await requestWorkspaceDir(
      new Request('http://localhost/x', { headers: clientHeader({ linked_workspace_dir: linked }) }),
    )
    expect(resolved).toBe(linked)
    // A bogus dir is validated away, falling back to the default.
    const bogus = await requestWorkspaceDir(
      new Request('http://localhost/x', {
        headers: clientHeader({ linked_workspace_dir: '/definitely/not/a/real/margin/workspace' }),
      }),
    )
    expect(bogus).toBe(defaultWorkspaceDir())
    // Explicit sample ignores a settings.json linked dir set by another client.
    await invoke(LinkRoute, 'POST', 'workspace/link', { path: linked })
    const sample = await requestWorkspaceDir(
      new Request('http://localhost/x', { headers: clientHeader({ linked_workspace_dir: '' }) }),
    )
    expect(sample).toBe(defaultWorkspaceDir())
    // Meanwhile an unconfigured caller now honors the linked server default.
    expect(await requestWorkspaceDir(new Request('http://localhost/x'))).toBe(linked)
  })

  it('routes workspace-scoped handlers from the header', async () => {
    const create = await handlersOf(FilesRoute).POST({
      request: new Request('http://localhost/api/workspace/files', {
        method: 'POST',
        headers: { ...clientHeader({ linked_workspace_dir: linked }), 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: 'chapters', name: 'client', content: '# C' }),
      }),
    } as never)
    expect(create.status).toBe(200)
    const stats = await handlersOf(StatsRoute).GET({
      request: new Request('http://localhost/api/workspace/stats', {
        headers: clientHeader({ linked_workspace_dir: linked }),
      }),
    } as never)
    const data = (await stats.json()) as { stats: { markdown_files: number } }
    expect(data.stats.markdown_files).toBe(1)
  })
})

beforeAll(() => undefined)
