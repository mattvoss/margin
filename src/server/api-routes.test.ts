// @vitest-environment node
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

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

  it('rejects empty message', async () => {
    const r = await invoke(AssistSimpleRoute, 'POST', 'assist/simple', { mode: 'chat', message: '  ' })
    expect(r.status).toBe(400)
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
