/**
 * Shared character-tracker shapes.
 *
 * Kept in `lib/` (not `server/`) so the client store and dialog can import the
 * types without pulling any server-only modules into the browser bundle.
 */

export interface CharacterAppearance {
  hair: string
  eyes: string
  face: string
  height: string
  build: string
  skin: string
}

export interface TrackedCharacter {
  id: string
  name: string
  aliases: string[]
  active: boolean
  role: string
  summary: string
  clothes: string
  appearance: CharacterAppearance
  accessories: string
  first_seen: string
  last_seen: string
  updated_at: string
}

export interface CharacterState {
  version: 1
  updated_at: string
  source_path: string | null
  source_session: string | null
  characters: TrackedCharacter[]
}

/** Fields the dialog owns when creating or editing a character. */
export interface CharacterDraft {
  name: string
  aliases: string[]
  active: boolean
  role: string
  summary: string
  clothes: string
  appearance: CharacterAppearance
  accessories: string
}

export const CHARACTER_STATE_PATH = 'characters/ACTIVE_CHARACTERS.json'
export const MAX_TRACKED_CHARACTERS = 40
export const CHARACTER_PROMPT_MARKER = '```CHARACTERS:```'

/** Format the workspace cast as a standalone user-message payload. */
export function formatCharacterPrompt(state: CharacterState): string | null {
  if (state.characters.length === 0) return null

  const characters = state.characters.map((character) => ({
    name: character.name,
    aliases: character.aliases,
    status: character.active ? 'active' : 'inactive',
    role: character.role,
    summary: character.summary,
    clothes: character.clothes,
    appearance: character.appearance,
    accessories: character.accessories,
  }))

  return `${CHARACTER_PROMPT_MARKER}\n${JSON.stringify({ characters }, null, 2)}`
}

export function emptyAppearance(): CharacterAppearance {
  return { hair: '', eyes: '', face: '', height: '', build: '', skin: '' }
}

export function emptyCharacterState(now = new Date().toISOString()): CharacterState {
  return {
    version: 1,
    updated_at: now,
    source_path: null,
    source_session: null,
    characters: [],
  }
}
