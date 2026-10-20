/**
 * characters.server.ts — active-cast tracker.
 *
 * State lives in the workspace at `characters/ACTIVE_CHARACTERS.json`. The
 * client triggers extraction after a generation (or on an explicit rescan);
 * the server builds the prompt, calls the active endpoint, merges the JSON
 * result into the existing cast, and writes the file.
 *
 * Merge philosophy:
 *  - Match by name, then alias.
 *  - Non-empty extracted fields overwrite; empty fields preserve prior values.
 *  - "Active" is story-active, not scene-present. A character is only
 *    deactivated when the text explicitly writes them out (death, permanent
 *    departure, etc.). Absence from a passage or chapter is not evidence.
 */

import {
  getActiveContextWindow,
  loadSimplePrompt,
  resolveSimpleAssistClientConfig,
  type AssistSettings,
} from './assist.server'
import { LLMClient } from './llm.server'
import { errMsg } from './http.server'
import { readWorkspaceFile, writeWorkspaceTextFile } from './storage.server'
import {
  CHARACTER_STATE_PATH,
  MAX_TRACKED_CHARACTERS,
  emptyAppearance,
  emptyCharacterState,
  type CharacterAppearance,
  type CharacterState,
  type TrackedCharacter,
} from '../lib/characters'

export { CHARACTER_STATE_PATH, MAX_TRACKED_CHARACTERS }

const FIELD_LIMITS = {
  name: 120,
  alias: 80,
  role: 160,
  summary: 600,
  clothes: 400,
  hair: 200,
  eyes: 120,
  face: 300,
  height: 80,
  build: 120,
  skin: 120,
  accessories: 400,
} as const

const MAX_ALIASES = 12
const MAX_SCAN_CHUNKS = 8
const EXTRACTION_TEMPERATURE = 0.2
const EXTRACTION_MAX_TOKENS = 4096
const EXTRACTION_STATIC_OVERHEAD_TOKENS = 1200
const APPEARANCE_KEYS = ['hair', 'eyes', 'face', 'height', 'build', 'skin'] as const

export class CharacterValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CharacterValidationError'
  }
}

export class CharacterNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CharacterNotFoundError'
  }
}

export class CharacterStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CharacterStateError'
  }
}

export class CharacterExtractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CharacterExtractionError'
  }
}

export interface ExtractedCharacter {
  name: string
  aliases: string[]
  active?: boolean
  exited?: boolean
  role: string
  summary: string
  clothes: string
  appearance: CharacterAppearance
  accessories: string
}

export type ExtractMode = 'passage' | 'rescan'

export interface ExtractionMergeOptions {
  mode: ExtractMode
  sourcePath: string | null
  sourceSession: string | null
  now?: string
}

export interface CharacterExtractionOptions {
  mode: ExtractMode
  text: string
  filePath: string | null
  sessionId: string | null
  prior: CharacterState
  settings: AssistSettings
  signal?: AbortSignal
}

function nowIso(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function has(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 1) return true
  if (value === 0) return false
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['true', 'yes', '1', 'active', 'alive'].includes(v)) return true
    if (['false', 'no', '0', 'inactive', 'dead', 'exited', 'departed'].includes(v)) return false
  }
  return fallback
}

function optionalBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 1) return true
  if (value === 0) return false
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['true', 'yes', '1', 'active', 'alive'].includes(v)) return true
    if (['false', 'no', '0', 'inactive', 'dead', 'exited', 'departed'].includes(v)) return false
  }
  return undefined
}

function nameKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function sameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b)
}

function normalizeAliases(value: unknown, name = ''): string[] {
  const raw: string[] = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') raw.push(item)
    }
  } else if (typeof value === 'string') {
    raw.push(...value.split(','))
  }

  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    const alias = text(item, FIELD_LIMITS.alias)
    if (!alias) continue
    const key = nameKey(alias)
    if (name && sameName(alias, name)) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(alias)
    if (out.length >= MAX_ALIASES) break
  }
  return out
}

function normalizeAppearance(value: unknown): CharacterAppearance {
  const src = isRecord(value) ? value : {}
  const appearance = emptyAppearance()
  for (const key of APPEARANCE_KEYS) {
    appearance[key] = text(src[key], FIELD_LIMITS[key])
  }
  return appearance
}

function mergeAppearance(prior: CharacterAppearance, incoming: CharacterAppearance): CharacterAppearance {
  return {
    hair: incoming.hair || prior.hair,
    eyes: incoming.eyes || prior.eyes,
    face: incoming.face || prior.face,
    height: incoming.height || prior.height,
    build: incoming.build || prior.build,
    skin: incoming.skin || prior.skin,
  }
}

function hashString(value: string): string {
  let hash = 0
  for (const char of value) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  }
  return hash.toString(36).slice(0, 6)
}

function slugBase(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || `character-${hashString(name)}`
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

function cloneCharacter(character: TrackedCharacter): TrackedCharacter {
  return {
    ...character,
    aliases: [...character.aliases],
    appearance: { ...character.appearance },
  }
}

function normalizeStoredCharacter(
  raw: unknown,
  usedIds: Set<string>,
  now: string,
): TrackedCharacter | null {
  if (!isRecord(raw)) return null
  const name = text(raw.name, FIELD_LIMITS.name)
  if (!name) return null

  let id = text(raw.id, 100)
  if (!id || usedIds.has(id)) id = uniqueId(slugBase(name), usedIds)
  usedIds.add(id)

  return {
    id,
    name,
    aliases: normalizeAliases(raw.aliases, name),
    active: bool(raw.active, true),
    role: text(raw.role, FIELD_LIMITS.role),
    summary: text(raw.summary, FIELD_LIMITS.summary),
    clothes: text(raw.clothes, FIELD_LIMITS.clothes),
    appearance: normalizeAppearance(raw.appearance),
    accessories: text(raw.accessories, FIELD_LIMITS.accessories),
    first_seen: text(raw.first_seen, 40) || now,
    last_seen: text(raw.last_seen, 40) || now,
    updated_at: text(raw.updated_at, 40) || now,
  }
}

/** Tolerant normalizer used for reads and before writes. */
export function normalizeCharacterState(
  raw: unknown,
  now = nowIso(),
): CharacterState {
  if (raw == null) return emptyCharacterState(now)
  if (!isRecord(raw)) {
    throw new CharacterStateError('Character state must be a JSON object.')
  }

  const list = raw.characters
  if (list != null && !Array.isArray(list)) {
    throw new CharacterStateError('Character state has no characters array.')
  }

  const used = new Set<string>()
  const characters = (Array.isArray(list) ? list : [])
    .map((item) => normalizeStoredCharacter(item, used, now))
    .filter((item): item is TrackedCharacter => item !== null)
    .slice(0, MAX_TRACKED_CHARACTERS)

  return {
    version: 1,
    updated_at: text(raw.updated_at, 40) || now,
    source_path:
      typeof raw.source_path === 'string' && raw.source_path.trim()
        ? raw.source_path.trim()
        : null,
    source_session:
      typeof raw.source_session === 'string' && raw.source_session.trim()
        ? raw.source_session.trim()
        : null,
    characters,
  }
}

export async function readCharacterState(workspaceDir: string): Promise<CharacterState> {
  let raw: string
  try {
    raw = await readWorkspaceFile(CHARACTER_STATE_PATH, workspaceDir)
  } catch (e) {
    if (errMsg(e).includes('File not found')) return emptyCharacterState()
    throw new CharacterStateError(`Could not read character state: ${errMsg(e)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new CharacterStateError(`Character state is not valid JSON: ${errMsg(e)}`)
  }
  return normalizeCharacterState(parsed)
}

export async function writeCharacterState(
  workspaceDir: string,
  state: CharacterState,
): Promise<void> {
  const normalized = normalizeCharacterState(state)
  await writeWorkspaceTextFile(
    CHARACTER_STATE_PATH,
    `${JSON.stringify(normalized, null, 2)}\n`,
    workspaceDir,
  )
}

function findByName(characters: TrackedCharacter[], name: string): TrackedCharacter | undefined {
  return characters.find((character) => sameName(character.name, name))
}

function findByAlias(
  characters: TrackedCharacter[],
  names: string[],
): TrackedCharacter | undefined {
  return characters.find((character) =>
    [character.name, ...character.aliases].some((existing) =>
      names.some((name) => sameName(existing, name)),
    ),
  )
}

function capCharacters(characters: TrackedCharacter[]): TrackedCharacter[] {
  if (characters.length <= MAX_TRACKED_CHARACTERS) return characters
  const ranked = [...characters].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    return (b.last_seen || '').localeCompare(a.last_seen || '')
  })
  const keep = new Set(ranked.slice(0, MAX_TRACKED_CHARACTERS).map((c) => c.id))
  return characters.filter((c) => keep.has(c.id))
}

function mergeIntoCharacter(
  target: TrackedCharacter,
  incoming: ExtractedCharacter,
  now: string,
): void {
  if (!sameName(target.name, incoming.name)) {
    if (
      target.aliases.length < MAX_ALIASES &&
      !target.aliases.some((alias) => sameName(alias, incoming.name))
    ) {
      target.aliases.push(incoming.name)
    }
  }
  for (const alias of incoming.aliases) {
    if (
      target.aliases.length < MAX_ALIASES &&
      !sameName(alias, target.name) &&
      !target.aliases.some((existing) => sameName(existing, alias))
    ) {
      target.aliases.push(alias)
    }
  }

  const active = incoming.exited === true ? false : incoming.active
  if (active !== undefined) target.active = active

  target.role = incoming.role || target.role
  target.summary = incoming.summary || target.summary
  target.clothes = incoming.clothes || target.clothes
  target.accessories = incoming.accessories || target.accessories
  target.appearance = mergeAppearance(target.appearance, incoming.appearance)
  target.last_seen = now
  target.updated_at = now
}

/**
 * Merge one extraction result into the prior state.
 *
 * Both modes preserve unmentioned characters' status: active means "still in
 * the story", not "on stage right now". The mode only changes the prompt's
 * scope (a passage vs. the full chapter).
 */
export function mergeExtraction(
  prior: CharacterState,
  extracted: ExtractedCharacter[],
  options: ExtractionMergeOptions,
): CharacterState {
  const now = options.now ?? nowIso()
  const characters = prior.characters.map(cloneCharacter)
  const used = new Set(characters.map((c) => c.id))

  for (const incoming of extracted) {
    const name = text(incoming.name, FIELD_LIMITS.name)
    if (!name) continue

    const normalized: ExtractedCharacter = {
      ...incoming,
      name,
      aliases: normalizeAliases(incoming.aliases, name),
    }

    const match =
      findByName(characters, name) ??
      findByAlias(characters, [name, ...normalized.aliases])

    if (match) {
      mergeIntoCharacter(match, normalized, now)
      continue
    }

    // Never evict an existing cast member to make room for a new one. Manual
    // adds are blocked at the same limit, so the user decides who leaves.
    if (characters.length >= MAX_TRACKED_CHARACTERS) continue

    const character: TrackedCharacter = {
      id: uniqueId(slugBase(name), used),
      name,
      aliases: normalized.aliases,
      active: normalized.exited === true ? false : (normalized.active ?? true),
      role: normalized.role,
      summary: normalized.summary,
      clothes: normalized.clothes,
      appearance: normalized.appearance,
      accessories: normalized.accessories,
      first_seen: now,
      last_seen: now,
      updated_at: now,
    }
    characters.push(character)
    used.add(character.id)
  }

  return {
    version: 1,
    updated_at: now,
    source_path: options.sourcePath ?? prior.source_path,
    source_session: options.sourceSession ?? prior.source_session,
    characters: capCharacters(characters),
  }
}

function normalizeExtracted(raw: unknown): ExtractedCharacter | null {
  if (!isRecord(raw)) return null
  const name = text(raw.name, FIELD_LIMITS.name)
  if (!name) return null

  const aliases = normalizeAliases(raw.aliases, name)
  const active = optionalBool(raw.active)
  const exited =
    typeof raw.exited === 'boolean'
      ? raw.exited
      : typeof raw.exited === 'string'
        ? bool(raw.exited, false)
        : undefined

  return {
    name,
    aliases,
    active,
    exited,
    role: text(raw.role, FIELD_LIMITS.role),
    summary: text(raw.summary, FIELD_LIMITS.summary),
    clothes: text(raw.clothes, FIELD_LIMITS.clothes),
    appearance: normalizeAppearance(raw.appearance),
    accessories: text(raw.accessories, FIELD_LIMITS.accessories),
  }
}

/** Parse the model's JSON, tolerating fences, prose preamble, or a bare array. */
export function parseExtraction(raw: string): ExtractedCharacter[] {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new CharacterExtractionError('Character tracker returned an empty response.')
  }

  let cleaned = raw.replace(/^\uFEFF/, '').trim()
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  const parse = (value: string): unknown => {
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }

  let parsed = parse(cleaned)
  if (parsed === undefined) {
    const objectStart = cleaned.indexOf('{')
    const objectEnd = cleaned.lastIndexOf('}')
    const arrayStart = cleaned.indexOf('[')
    const arrayEnd = cleaned.lastIndexOf(']')
    const candidates: string[] = []
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      candidates.push(cleaned.slice(arrayStart, arrayEnd + 1))
    }
    if (objectStart !== -1 && objectEnd > objectStart) {
      candidates.push(cleaned.slice(objectStart, objectEnd + 1))
    }
    for (const candidate of candidates) {
      parsed = parse(candidate)
      if (parsed !== undefined) break
    }
    if (parsed === undefined) {
      throw new CharacterExtractionError(
        candidates.length === 0
          ? 'Character tracker returned no JSON.'
          : 'Character tracker returned invalid JSON.',
      )
    }
  }

  let list: unknown[] = []
  if (Array.isArray(parsed)) {
    list = parsed
  } else if (isRecord(parsed)) {
    if (Array.isArray(parsed.characters)) list = parsed.characters
    else if (isRecord(parsed.character)) list = [parsed.character]
    else if (typeof parsed.name === 'string') list = [parsed]
  }

  return list
    .map(normalizeExtracted)
    .filter((item): item is ExtractedCharacter => item !== null)
    .slice(0, MAX_TRACKED_CHARACTERS)
}

function compactCharacterForPrompt(character: TrackedCharacter) {
  // This is only a matching aid. The merge happens locally, so the model does
  // not need the full description or appearance of every prior character.
  return {
    name: character.name,
    aliases: character.aliases,
    active: character.active,
    role: character.role.slice(0, 80),
    summary: character.summary.slice(0, 180),
  }
}

function splitOversizedParagraph(paragraph: string, budget: number): string[] {
  const sentences = paragraph.split(/(?<=[.!?])\s+/)
  const out: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (sentence.length > budget) {
      if (current) {
        out.push(current)
        current = ''
      }
      for (let i = 0; i < sentence.length; i += budget) {
        out.push(sentence.slice(i, i + budget))
      }
    } else if (current && current.length + 1 + sentence.length > budget) {
      out.push(current)
      current = sentence
    } else {
      current = current ? `${current} ${sentence}` : sentence
    }
  }
  if (current) out.push(current)
  return out
}

function splitTextAtParagraphs(value: string, budget: number): string[] {
  const paragraphs = value.split(/\n\s*\n/)
  const chunks: string[] = []
  let current = ''

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim()
    if (!trimmed) continue

    if (trimmed.length > budget) {
      if (current) {
        chunks.push(current)
        current = ''
      }
      chunks.push(...splitOversizedParagraph(trimmed, budget))
      continue
    }

    if (current && current.length + 2 + trimmed.length > budget) {
      chunks.push(current)
      current = trimmed
    } else {
      current = current ? `${current}\n\n${trimmed}` : trimmed
    }
  }

  if (current) chunks.push(current)
  return chunks
}

/**
 * Split a long chapter into extraction-sized pieces. Uses the active
 * endpoint's context window, reserving room for the prompt, current state and
 * the JSON response. If the text still exceeds the call budget, samples
 * evenly across the chapter so the beginning and end are both represented.
 */
export function planCharacterChunks(
  value: string,
  settings: AssistSettings,
  prior: CharacterState,
): string[] {
  const clean = value.trim()
  if (!clean) return []

  const contextWindow = getActiveContextWindow(settings)
  const priorChars = JSON.stringify(prior.characters.map(compactCharacterForPrompt))
  const priorTokens = Math.ceil(priorChars.length / 4)
  const available = Math.max(
    600,
    contextWindow -
      priorTokens -
      EXTRACTION_STATIC_OVERHEAD_TOKENS -
      EXTRACTION_MAX_TOKENS,
  )
  const budgetChars = Math.max(1600, Math.min(80000, Math.floor(available * 3.5)))

  if (clean.length <= budgetChars) return [clean]

  const chunks = splitTextAtParagraphs(clean, budgetChars)
  if (chunks.length <= MAX_SCAN_CHUNKS) return chunks

  const step = (chunks.length - 1) / (MAX_SCAN_CHUNKS - 1)
  const sampled: string[] = []
  for (let i = 0; i < MAX_SCAN_CHUNKS; i += 1) {
    const chunk = chunks[Math.round(i * step)]
    if (chunk && !sampled.includes(chunk)) sampled.push(chunk)
  }
  return sampled
}

function buildExtractionPrompt(
  mode: ExtractMode,
  sourcePath: string | null,
  state: CharacterState,
  chunk: string,
  index: number,
  total: number,
): string {
  const lines = [
    `MODE: ${mode === 'rescan' ? 'rescan (full chapter)' : 'passage (newly generated prose)'}`,
    `SOURCE: ${sourcePath ?? '(unknown)'}`,
    `CHUNK: ${index + 1} of ${total}`,
    '',
  ]

  if (mode === 'rescan') {
    lines.push(
      'Report every character referenced anywhere in this chapter. Do not deactivate a character merely because they are absent from this chapter.',
      '',
    )
  } else {
    lines.push(
      'Report the characters referenced in this passage. Do not repeat characters from CURRENT STATE unless they are referenced here.',
      '',
    )
  }

  lines.push(
    'CURRENT STATE:',
    JSON.stringify({ characters: state.characters.map(compactCharacterForPrompt) }),
    '',
    'TEXT:',
    chunk,
    '',
    'Return JSON only, in the shape described in your instructions.',
  )

  return lines.join('\n')
}

function extractionResponseDetail(client: LLMClient): string {
  const parts: string[] = []
  if (client.lastFinishReason) parts.push(`finish_reason=${client.lastFinishReason}`)
  if (client.lastContentChars != null) parts.push(`content_chars=${client.lastContentChars}`)
  if (client.lastUsage) parts.push(`completion_tokens=${client.lastUsage.completion_tokens}`)
  if (client.lastThinking) parts.push(`reasoning_chars=${client.lastThinking.length}`)
  return parts.length ? ` (${parts.join(', ')})` : ''
}

export async function extractAndMergeCharacters(
  options: CharacterExtractionOptions,
): Promise<CharacterState> {
  const value = options.text.trim()
  if (!value) throw new CharacterValidationError('No text to scan.')

  const config = resolveSimpleAssistClientConfig(options.settings)
  const systemPrompt = await loadSimplePrompt('character-tracker.md')
  if (!systemPrompt.trim()) {
    throw new CharacterExtractionError('Character tracker prompt is missing or empty.')
  }

  const client = new LLMClient({
    model: config.model ?? undefined,
    baseUrl: config.baseUrl ?? undefined,
    apiKey: config.apiKey ?? undefined,
    isThinking: config.isThinking,
    customOpeningTags: config.customOpeningTags,
    customClosingTags: config.customClosingTags,
  })

  const chunks = planCharacterChunks(value, options.settings, options.prior)
  let state = options.prior

  for (let i = 0; i < chunks.length; i += 1) {
    const prompt = buildExtractionPrompt(
      options.mode,
      options.filePath,
      state,
      chunks[i],
      i,
      chunks.length,
    )

    let raw: string
    try {
      raw = await client.generateBlocking(systemPrompt, prompt, {
        temperature: EXTRACTION_TEMPERATURE,
        maxTokens: EXTRACTION_MAX_TOKENS,
        signal: options.signal,
      })
    } catch (e) {
      throw new CharacterExtractionError(`Character tracker request failed: ${errMsg(e)}`)
    }

    const firstAttemptDetail = extractionResponseDetail(client)
    let parsed: ExtractedCharacter[] | null = null
    if (raw.trim()) {
      try {
        parsed = parseExtraction(raw)
      } catch {
        // Fall through to the non-thinking retry below.
      }
    }

    if (!parsed) {
      try {
        // Extraction is mechanical. If the model spent its budget thinking
        // (or returned no usable content), retry with the template's thinking
        // mode disabled and allow reasoning_content as a last-resort answer.
        raw = await client.generateBlocking(systemPrompt, prompt, {
          temperature: EXTRACTION_TEMPERATURE,
          maxTokens: EXTRACTION_MAX_TOKENS,
          signal: options.signal,
          enableThinking: false,
          fallbackToReasoning: true,
        })
      } catch (e) {
        throw new CharacterExtractionError(
          `Character tracker retry failed${firstAttemptDetail}: ${errMsg(e)}`,
        )
      }

      if (!raw.trim()) {
        throw new CharacterExtractionError(
          `Character tracker returned an empty response${extractionResponseDetail(client)}.`,
        )
      }

      try {
        parsed = parseExtraction(raw)
      } catch (e) {
        if (e instanceof CharacterExtractionError) {
          throw new CharacterExtractionError(
            `${e.message}${extractionResponseDetail(client)}`,
          )
        }
        throw e
      }
    }

    if (!parsed) {
      throw new CharacterExtractionError(
        `Character tracker returned invalid JSON${extractionResponseDetail(client)}.`,
      )
    }

    state = mergeExtraction(state, parsed, {
      mode: options.mode,
      sourcePath: options.filePath,
      sourceSession: options.sessionId,
    })
  }

  return state
}

/**
 * Apply a user edit from the dialog. Unlike extraction, provided fields are
 * replaced exactly — an empty string clears the field.
 */
export function applyManualAction(
  state: CharacterState,
  raw: Record<string, unknown>,
  now = nowIso(),
): CharacterState {
  const action = typeof raw.action === 'string' ? raw.action : ''
  const characters = state.characters.map(cloneCharacter)
  const used = new Set(characters.map((character) => character.id))

  if (action === 'create') {
    const input = isRecord(raw.character) ? raw.character : raw
    const name = text(input.name, FIELD_LIMITS.name)
    if (!name) throw new CharacterValidationError('Name is required.')
    if (characters.length >= MAX_TRACKED_CHARACTERS) {
      throw new CharacterValidationError(
        `The cast is limited to ${MAX_TRACKED_CHARACTERS} characters.`,
      )
    }

    const character: TrackedCharacter = {
      id: uniqueId(slugBase(name), used),
      name,
      aliases: normalizeAliases(input.aliases, name),
      active: bool(input.active, true),
      role: text(input.role, FIELD_LIMITS.role),
      summary: text(input.summary, FIELD_LIMITS.summary),
      clothes: text(input.clothes, FIELD_LIMITS.clothes),
      appearance: normalizeAppearance(input.appearance),
      accessories: text(input.accessories, FIELD_LIMITS.accessories),
      first_seen: now,
      last_seen: now,
      updated_at: now,
    }
    characters.push(character)
    return { ...state, updated_at: now, characters }
  }

  if (action === 'update') {
    const id = text(raw.id, 100)
    if (!id) throw new CharacterValidationError('Character id is required.')
    const target = characters.find((character) => character.id === id)
    if (!target) throw new CharacterNotFoundError(`Character not found: ${id}`)
    if (!isRecord(raw.updates)) {
      throw new CharacterValidationError('Character updates are required.')
    }
    const updates = raw.updates

    if (has(updates, 'name')) {
      const nextName = text(updates.name, FIELD_LIMITS.name)
      if (!nextName) throw new CharacterValidationError('Name cannot be empty.')
      if (!sameName(nextName, target.name)) {
        if (
          target.aliases.length < MAX_ALIASES &&
          !target.aliases.some((alias) => sameName(alias, target.name))
        ) {
          target.aliases.push(target.name)
        }
      }
      target.name = nextName
    }

    if (has(updates, 'aliases')) {
      target.aliases = normalizeAliases(updates.aliases, target.name)
    }
    if (has(updates, 'active')) {
      target.active = bool(updates.active, target.active)
    }
    if (has(updates, 'role')) target.role = text(updates.role, FIELD_LIMITS.role)
    if (has(updates, 'summary')) target.summary = text(updates.summary, FIELD_LIMITS.summary)
    if (has(updates, 'clothes')) target.clothes = text(updates.clothes, FIELD_LIMITS.clothes)
    if (has(updates, 'accessories')) {
      target.accessories = text(updates.accessories, FIELD_LIMITS.accessories)
    }
    if (isRecord(updates.appearance)) {
      for (const key of APPEARANCE_KEYS) {
        if (has(updates.appearance, key)) {
          target.appearance[key] = text(updates.appearance[key], FIELD_LIMITS[key])
        }
      }
    }

    target.updated_at = now
    return { ...state, updated_at: now, characters }
  }

  if (action === 'delete') {
    const id = text(raw.id, 100)
    if (!id) throw new CharacterValidationError('Character id is required.')
    const index = characters.findIndex((character) => character.id === id)
    if (index === -1) throw new CharacterNotFoundError(`Character not found: ${id}`)
    characters.splice(index, 1)
    return { ...state, updated_at: now, characters }
  }

  throw new CharacterValidationError(`Unknown action: ${action || '(missing)'}`)
}
