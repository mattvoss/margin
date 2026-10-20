import { describe, expect, it } from 'vitest'
import {
  emptyAppearance,
  emptyCharacterState,
  formatCharacterPrompt,
  type TrackedCharacter,
} from './characters'

function character(overrides: Partial<TrackedCharacter> = {}): TrackedCharacter {
  return {
    id: 'mara',
    name: 'Mara Venn',
    aliases: ['Mara'],
    active: true,
    role: 'protagonist',
    summary: 'A cartographer searching for her brother.',
    clothes: 'green coat',
    appearance: { ...emptyAppearance(), hair: 'black', eyes: 'brown' },
    accessories: 'brass compass',
    first_seen: '2026-01-01T00:00:00.000Z',
    last_seen: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('formatCharacterPrompt', () => {
  it('omits the context message for an empty cast', () => {
    expect(formatCharacterPrompt(emptyCharacterState())).toBeNull()
  })

  it('prefixes all cast entries with the marker and excludes storage metadata', () => {
    const state = emptyCharacterState()
    state.characters = [character(), character({
      id: 'orin',
      name: 'Orin Vale',
      aliases: [],
      active: false,
      role: 'supporting',
    })]

    const result = formatCharacterPrompt(state)
    expect(result?.startsWith('```CHARACTERS:```\n')).toBe(true)
    const payload = JSON.parse(result!.slice('```CHARACTERS:```\n'.length)) as {
      characters: Array<Record<string, unknown>>
    }
    expect(payload.characters).toHaveLength(2)
    expect(payload.characters[0]).toMatchObject({
      name: 'Mara Venn',
      aliases: ['Mara'],
      status: 'active',
      clothes: 'green coat',
      appearance: { hair: 'black', eyes: 'brown' },
      accessories: 'brass compass',
    })
    expect(payload.characters[1]).toMatchObject({ name: 'Orin Vale', status: 'inactive' })
    expect(payload.characters[0]).not.toHaveProperty('id')
    expect(payload.characters[0]).not.toHaveProperty('first_seen')
  })
})
