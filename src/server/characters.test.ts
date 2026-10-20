// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

process.env.MARGIN_TEST_DIR = mkdtempSync(join(tmpdir(), 'margin-characters-test-'))

import {
  CharacterNotFoundError,
  CharacterStateError,
  CharacterValidationError,
  applyManualAction,
  mergeExtraction,
  parseExtraction,
  planCharacterChunks,
  readCharacterState,
  writeCharacterState,
  type ExtractedCharacter,
} from './characters.server'
import { Route as CharactersRoute } from '../routes/api.assist.characters'
import type { AssistSettings } from './assist.server'
import {
  CHARACTER_STATE_PATH,
  emptyAppearance,
  type CharacterAppearance,
  type CharacterState,
  type TrackedCharacter,
} from '../lib/characters'

const NOW = '2026-01-01T12:00:00.000Z'
const LATER = '2026-01-02T12:00:00.000Z'
const tempDirs: string[] = []

afterAll(() => {
  rmSync(process.env.MARGIN_TEST_DIR!, { recursive: true, force: true })
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

type CharacterOverrides = Omit<Partial<TrackedCharacter>, 'aliases' | 'appearance'> & {
  aliases?: string[]
  appearance?: Partial<CharacterAppearance>
}

function makeCharacter(overrides: CharacterOverrides = {}): TrackedCharacter {
  const base: TrackedCharacter = {
    id: 'elara',
    name: 'Elara',
    aliases: [],
    active: true,
    role: '',
    summary: '',
    clothes: '',
    appearance: emptyAppearance(),
    accessories: '',
    first_seen: NOW,
    last_seen: NOW,
    updated_at: NOW,
  }
  return {
    ...base,
    ...overrides,
    aliases: overrides.aliases ?? base.aliases,
    appearance: { ...emptyAppearance(), ...(overrides.appearance ?? {}) },
  }
}

function makeState(characters: TrackedCharacter[]): CharacterState {
  return {
    version: 1,
    updated_at: NOW,
    source_path: 'chapters/01.md',
    source_session: null,
    characters,
  }
}

function workspaceRequest(
  method: string,
  workspace: string,
  body?: unknown,
): Request {
  const headers: Record<string, string> = {
    'x-margin-client-settings': encodeURIComponent(
      JSON.stringify({ linked_workspace_dir: workspace }),
    ),
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return new Request('http://localhost/api/assist/characters', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function handlersOf(
  route: unknown,
): Record<string, (ctx: { request: Request }) => Promise<Response>> {
  return (
    route as {
      options: {
        server: { handlers: Record<string, (ctx: { request: Request }) => Promise<Response>> }
      }
    }
  ).options.server.handlers
}

type ExtractedOverrides = Omit<
  Partial<ExtractedCharacter>,
  'name' | 'aliases' | 'appearance'
> & {
  name: string
  aliases?: string[]
  appearance?: Partial<CharacterAppearance>
}

function extracted(overrides: ExtractedOverrides): ExtractedCharacter {
  return {
    name: overrides.name,
    aliases: overrides.aliases ?? [],
    active: overrides.active,
    exited: overrides.exited,
    role: overrides.role ?? '',
    summary: overrides.summary ?? '',
    clothes: overrides.clothes ?? '',
    appearance: { ...emptyAppearance(), ...(overrides.appearance ?? {}) },
    accessories: overrides.accessories ?? '',
  }
}

describe('mergeExtraction', () => {
  it('updates mentioned characters and leaves everyone else untouched', () => {
    const prior = makeState([
      makeCharacter({ id: 'elara', name: 'Elara', clothes: 'grey coat' }),
      makeCharacter({ id: 'kaelen', name: 'Kaelen', active: true }),
      makeCharacter({ id: 'mira', name: 'Mira', active: false }),
    ])

    const result = mergeExtraction(
      prior,
      [
        extracted({
          name: 'Elara',
          active: true,
          clothes: 'blue coat',
          appearance: { hair: 'black' },
        }),
      ],
      { mode: 'passage', sourcePath: 'chapters/02.md', sourceSession: 's1', now: LATER },
    )

    const elara = result.characters.find((c) => c.id === 'elara')!
    expect(elara.clothes).toBe('blue coat')
    expect(elara.appearance.hair).toBe('black')
    expect(elara.last_seen).toBe(LATER)
    expect(result.characters.find((c) => c.id === 'kaelen')!.active).toBe(true)
    expect(result.characters.find((c) => c.id === 'mira')!.active).toBe(false)
    expect(result.source_path).toBe('chapters/02.md')
    expect(result.source_session).toBe('s1')
  })

  it('only deactivates a character when the extraction explicitly does', () => {
    const prior = makeState([
      makeCharacter({ id: 'elara', name: 'Elara' }),
      makeCharacter({ id: 'kaelen', name: 'Kaelen' }),
    ])

    const result = mergeExtraction(
      prior,
      [extracted({ name: 'Kaelen', active: false, summary: 'Fell at the pass.' })],
      { mode: 'rescan', sourcePath: 'chapters/01.md', sourceSession: null, now: LATER },
    )

    expect(result.characters.find((c) => c.id === 'elara')!.active).toBe(true)
    expect(result.characters.find((c) => c.id === 'kaelen')!.active).toBe(false)
  })

  it('matches by alias, keeps the canonical name, and preserves empty fields', () => {
    const prior = makeState([
      makeCharacter({
        id: 'elara-vance',
        name: 'Elara Vance',
        aliases: ['El'],
        summary: 'A cartographer.',
        appearance: { hair: 'auburn', eyes: 'grey' },
      }),
    ])

    const result = mergeExtraction(
      prior,
      [
        extracted({
          name: 'El',
          active: true,
          summary: '',
          appearance: { eyes: 'green', hair: '' },
        }),
      ],
      { mode: 'passage', sourcePath: null, sourceSession: null, now: LATER },
    )

    expect(result.characters).toHaveLength(1)
    const character = result.characters[0]
    expect(character.id).toBe('elara-vance')
    expect(character.name).toBe('Elara Vance')
    expect(character.aliases).toContain('El')
    expect(character.summary).toBe('A cartographer.')
    expect(character.appearance.hair).toBe('auburn')
    expect(character.appearance.eyes).toBe('green')
  })

  it('adds new characters with stable ids and de-duplicates aliases', () => {
    const prior = makeState([])
    const result = mergeExtraction(
      prior,
      [
        extracted({
          name: 'Rook',
          aliases: ['The Grey', 'the grey', 'Rook'],
          role: 'antagonist',
        }),
      ],
      { mode: 'passage', sourcePath: null, sourceSession: null, now: LATER },
    )

    expect(result.characters).toHaveLength(1)
    expect(result.characters[0].id).toBe('rook')
    expect(result.characters[0].aliases).toEqual(['The Grey'])
    expect(result.characters[0].first_seen).toBe(LATER)
  })

  it('honors an explicit exited flag on a newly extracted character', () => {
    const result = mergeExtraction(
      makeState([]),
      [extracted({ name: 'The Warden', active: true, exited: true })],
      { mode: 'rescan', sourcePath: null, sourceSession: null, now: LATER },
    )

    expect(result.characters[0].active).toBe(false)
  })

  it('does not evict existing cast to add a newcomer at the cap', () => {
    const prior = makeState(
      Array.from({ length: 40 }, (_, index) =>
        makeCharacter({ id: `character-${index}`, name: `Character ${index}` }),
      ),
    )
    const result = mergeExtraction(
      prior,
      [extracted({ name: 'Newcomer' })],
      { mode: 'passage', sourcePath: null, sourceSession: null, now: LATER },
    )

    expect(result.characters).toHaveLength(40)
    expect(result.characters.some((character) => character.name === 'Newcomer')).toBe(
      false,
    )
  })
})

describe('parseExtraction', () => {
  it('parses fenced JSON and normalizes fields', () => {
    const result = parseExtraction(`\`\`\`json
      {"characters":[{"name":"  Elara  ","aliases":["El","el"],"active":true,"appearance":{"hair":"black"}}]}
    \`\`\``)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Elara')
    expect(result[0].aliases).toEqual(['El'])
    expect(result[0].appearance.hair).toBe('black')
  })

  it('accepts a bare array with surrounding prose', () => {
    const result = parseExtraction(
      'Here is the cast: [{"name":"Rook","active":"false"},{"name":"Elara"}] — done.',
    )
    expect(result).toHaveLength(2)
    expect(result[0].active).toBe(false)
    expect(result[1].name).toBe('Elara')
  })

  it('rejects responses without JSON', () => {
    expect(() => parseExtraction('I could not find any characters.')).toThrow()
  })
})

describe('applyManualAction', () => {
  it('creates, replaces provided fields, and deletes', () => {
    const state = makeState([])
    const created = applyManualAction(
      state,
      {
        action: 'create',
        character: {
          name: 'Rook',
          aliases: ['The Grey'],
          role: 'antagonist',
          summary: 'A hunter.',
        },
      },
      NOW,
    )

    expect(created.characters).toHaveLength(1)
    const rook = created.characters[0]
    expect(rook.active).toBe(true)
    expect(rook.aliases).toEqual(['The Grey'])

    const updated = applyManualAction(
      created,
      {
        action: 'update',
        id: rook.id,
        updates: {
          summary: '',
          clothes: 'red cloak',
          active: false,
          appearance: { eyes: 'green' },
        },
      },
      LATER,
    )
    const changed = updated.characters[0]
    expect(changed.summary).toBe('')
    expect(changed.clothes).toBe('red cloak')
    expect(changed.active).toBe(false)
    expect(changed.appearance.eyes).toBe('green')
    expect(changed.updated_at).toBe(LATER)

    const deleted = applyManualAction(updated, { action: 'delete', id: rook.id }, LATER)
    expect(deleted.characters).toHaveLength(0)
  })

  it('rejects empty names and unknown ids', () => {
    const state = makeState([makeCharacter({ id: 'elara', name: 'Elara' })])
    expect(() =>
      applyManualAction(state, { action: 'create', character: { name: '   ' } }),
    ).toThrow(CharacterValidationError)
    expect(() =>
      applyManualAction(state, {
        action: 'update',
        id: 'missing',
        updates: { role: 'ghost' },
      }),
    ).toThrow(CharacterNotFoundError)
  })

  it('preserves the old name as an alias when renaming', () => {
    const state = makeState([makeCharacter({ id: 'elara', name: 'Elara' })])
    const renamed = applyManualAction(
      state,
      { action: 'update', id: 'elara', updates: { name: 'Elara Vance' } },
      LATER,
    )
    expect(renamed.characters[0].name).toBe('Elara Vance')
    expect(renamed.characters[0].aliases).toContain('Elara')
  })
})

describe('character state I/O', () => {
  it('writes and reads the workspace JSON file', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'margin-characters-ws-'))
    tempDirs.push(workspace)

    const state = makeState([
      makeCharacter({ id: 'elara', name: 'Elara', active: true }),
    ])
    await writeCharacterState(workspace, state)

    expect(existsSync(join(workspace, CHARACTER_STATE_PATH))).toBe(true)
    const loaded = await readCharacterState(workspace)
    expect(loaded.characters).toHaveLength(1)
    expect(loaded.characters[0].name).toBe('Elara')
  })

  it('returns an empty state when the file is missing', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'margin-characters-empty-'))
    tempDirs.push(workspace)
    const loaded = await readCharacterState(workspace)
    expect(loaded.characters).toEqual([])
  })

  it('reports corrupt JSON instead of silently replacing the cast', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'margin-characters-corrupt-'))
    tempDirs.push(workspace)
    mkdirSync(join(workspace, 'characters'), { recursive: true })
    const file = join(workspace, CHARACTER_STATE_PATH)
    writeFileSync(file, '{not json', 'utf-8')
    await expect(readCharacterState(workspace)).rejects.toBeInstanceOf(CharacterStateError)
  })

  it('serves GET and applies PATCH create/update/delete through the route', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'margin-characters-route-'))
    tempDirs.push(workspace)
    const handlers = handlersOf(CharactersRoute)

    const empty = await handlers.GET({ request: workspaceRequest('GET', workspace) })
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as { state: CharacterState }).state.characters).toEqual([])

    const created = await handlers.PATCH({
      request: workspaceRequest('PATCH', workspace, {
        action: 'create',
        character: { name: 'Rook', role: 'antagonist' },
      }),
    })
    expect(created.status).toBe(200)
    const createdState = ((await created.json()) as { state: CharacterState }).state
    const rook = createdState.characters.find((character) => character.name === 'Rook')!
    expect(rook.active).toBe(true)

    const updated = await handlers.PATCH({
      request: workspaceRequest('PATCH', workspace, {
        action: 'update',
        id: rook.id,
        updates: { active: false, clothes: 'red cloak' },
      }),
    })
    expect(updated.status).toBe(200)
    const updatedState = ((await updated.json()) as { state: CharacterState }).state
    expect(updatedState.characters[0].active).toBe(false)
    expect(updatedState.characters[0].clothes).toBe('red cloak')

    const deleted = await handlers.PATCH({
      request: workspaceRequest('PATCH', workspace, { action: 'delete', id: rook.id }),
    })
    expect(deleted.status).toBe(200)
    expect(
      ((await deleted.json()) as { state: CharacterState }).state.characters,
    ).toEqual([])
  })
})

describe('planCharacterChunks', () => {
  it('splits a long chapter and caps the number of scans', () => {
    const settings = {
      active_endpoint: 'local',
      endpoints: {
        local: { url: 'http://localhost:1234/v1', model: 'test', context_window: 2048 },
      },
    } as unknown as AssistSettings

    const text = Array.from(
      { length: 300 },
      (_, index) => `Paragraph ${index}. ${'The road went on. '.repeat(30)}`,
    ).join('\n\n')

    const chunks = planCharacterChunks(text, settings, makeState([]))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.length).toBeLessThanOrEqual(8)
    expect(chunks[0].length).toBeLessThanOrEqual(8000)
  })

  it('returns an empty list for blank text', () => {
    const settings = { active_endpoint: null, endpoints: {} } as unknown as AssistSettings
    expect(planCharacterChunks('   ', settings, makeState([]))).toEqual([])
  })
})
