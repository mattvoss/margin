/**
 * Shared post-processing model.
 *
 * Concepts adapted from closuretxt/recast-post-processing (AGPL-3.0): an
 * ordered list of independent, individually toggleable passes, each with its
 * own prompt, model/endpoint, and context options. A pass receives only the
 * previous pass's text and never the original generation prompt.
 *
 * Kept in `lib/` so the settings UI, the server pipeline and the harness hook
 * all share one shape. Settings are server-synced (`post_processing`), not
 * browser-owned.
 */

export interface PostProcessPass {
  id: string
  name: string
  enabled: boolean
  prompt: string
  /** Endpoint id from `settings.endpoints`; null = active endpoint. */
  endpoint_id: string | null
  /** How many recent session turns travel as scene context. */
  context_length: number
  include_character: boolean
  include_scene: boolean
  include_pinned_refs: boolean
  include_document: boolean
  temperature: number
  /** Null = inherit the Writer's max-token setting. */
  max_tokens: number | null
}

export interface PostProcessPreset {
  id: string
  name: string
  passes: PostProcessPass[]
}

export interface PostProcessingSettings {
  enabled: boolean
  /** false = apply the final text inline; true = keep the accept/reject review. */
  review: boolean
  min_chars: number
  apply_to_edit: boolean
  apply_to_chat: boolean
  apply_to_harness: boolean
  active_preset: string
  presets: PostProcessPreset[]
}

export const MAX_POST_PROCESS_PASSES = 12
export const MAX_POST_PROCESS_PRESETS = 8
export const MAX_PASS_PROMPT_CHARS = 20_000
/** Harness runs post-process at most this many changed paragraph hunks. */
export const MAX_HARNESS_HUNKS = 6
/** And at most this many characters across those hunks. */
export const MAX_HARNESS_CHARS = 20_000

const GROUNDING_PROMPT = `You are a prose editor. Edit <text_to_transform> so it feels rooted in the story's world and consistent with its rules, tone, setting, and the way things work there. Make the text belong to this specific world. Do not invent new lore or guesswork.

When a character announces an action and then immediately executes it, or time passes abruptly, add one short beat between the two so the reader does not feel like they blinked and missed the transition. It can be a reaction, a half-second, anything that confirms time moved.

Return only the rewritten text. No explanations, no notes, no commentary.`

const VALIDATOR_PROMPT = `You are a character consistency editor. Your only job is to fix dialogue and actions in <text_to_transform> that are not in character. Do not improve prose. Do not fix grammar. Do not restructure sentences.

Priority order for character signals: example dialogue > personality traits > general description > scene context.

Fix text if it:
- Uses phrasing that contradicts the character's established voice
- Has the character act warmer, cooler, more helpful, or more dramatic than their character defines
- Responds only to the surface of what was said, ignoring what the other character is visibly feeling
- States emotion directly instead of showing it through behavior or word choice
- Resolves tension the character would hold

Return only the corrected text. No explanations, no commentary.`

const PROSE_PROMPT = `You are a prose editor. Your only job is to improve how <text_to_transform> reads without changing what it says.

Rules:
- Do not change any dialogue. Not a single word.
- Do not change what happens, what characters do, or the order of events
- Do not add new actions, reactions, or details that were not there
- Do not remove actions, reactions, or details that were there
- Keep the original verb tense and grammatical person
- Avoid repeating descriptive words; rephrase or remove repetition

What you may change:
- Sentence length variation; break up monotonous rhythm
- Eliminate repeated sentence structures, especially consecutive sentences starting the same way
- Convert telling to showing; replace emotion labels with physical behavior or action
- Cut filler phrases that carry no meaning
- Tighten wordy constructions without losing meaning
- Prefer flowing sentences connected by conjunctions over short stopped ones

Use the scene context only to match the established prose tone and register. Do not drift from the style already set.

Return only the rewritten text. No explanations, no notes, no commentary.`

const REPETITION_PROMPT = `Simplify <text_to_transform> by removing repeated words, phrases, and repeated dialogue beats.

Rules:
- Remove only words that can be removed without breaking the sentence
- Change wording only when the text still makes sense
- Prioritize removing repetition that is closest to the recent scene context
- Do not add new content

Return only the rewritten text. No explanations, no notes, no commentary.`

/** Four starter passes, all disabled until the user opts in. */
export const STARTER_PASSES: readonly PostProcessPass[] = [
  {
    id: 'starter_grounding',
    name: 'Grounding',
    enabled: false,
    prompt: GROUNDING_PROMPT,
    endpoint_id: null,
    context_length: 2,
    include_character: true,
    include_scene: true,
    include_pinned_refs: true,
    include_document: true,
    temperature: 0.2,
    max_tokens: null,
  },
  {
    id: 'starter_validator',
    name: 'Character Behavior Validator',
    enabled: false,
    prompt: VALIDATOR_PROMPT,
    endpoint_id: null,
    context_length: 4,
    include_character: true,
    include_scene: true,
    include_pinned_refs: false,
    include_document: true,
    temperature: 0.2,
    max_tokens: null,
  },
  {
    id: 'starter_prose',
    name: 'Prose Rhythm',
    enabled: false,
    prompt: PROSE_PROMPT,
    endpoint_id: null,
    context_length: 3,
    include_character: false,
    include_scene: true,
    include_pinned_refs: false,
    include_document: true,
    temperature: 0.4,
    max_tokens: null,
  },
  {
    id: 'starter_repetition',
    name: 'Repetition Hammer',
    enabled: false,
    prompt: REPETITION_PROMPT,
    endpoint_id: null,
    context_length: 4,
    include_character: false,
    include_scene: true,
    include_pinned_refs: false,
    include_document: false,
    temperature: 0.2,
    max_tokens: null,
  },
]

function cloneStarterPasses(): PostProcessPass[] {
  return STARTER_PASSES.map((pass) => ({ ...pass }))
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base
  let n = 2
  while (used.has(id)) {
    id = `${base}_${n}`
    n++
  }
  used.add(id)
  return id
}

export function createDefaultPostProcessing(): PostProcessingSettings {
  return {
    enabled: false,
    review: true,
    min_chars: 60,
    apply_to_edit: true,
    apply_to_chat: false,
    apply_to_harness: true,
    active_preset: 'default',
    presets: [{ id: 'default', name: 'Default', passes: cloneStarterPasses() }],
  }
}

/** Deep-enough clone used by the settings store and server defaults. */
export const DEFAULT_POST_PROCESSING: PostProcessingSettings = createDefaultPostProcessing()

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalizePass(raw: unknown, index: number): PostProcessPass | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const prompt = asString(r.prompt).slice(0, MAX_PASS_PROMPT_CHARS)
  if (!prompt.trim()) return null
  return {
    id: asString(r.id).trim() || `pass_${index + 1}`,
    name: asString(r.name).trim() || `Pass ${index + 1}`,
    enabled: asBool(r.enabled, false),
    prompt,
    endpoint_id:
      typeof r.endpoint_id === 'string' && r.endpoint_id.trim()
        ? r.endpoint_id.trim()
        : null,
    context_length: Math.round(clampNumber(r.context_length, 3, 0, 20)),
    include_character: asBool(r.include_character, false),
    include_scene: asBool(r.include_scene, false),
    include_pinned_refs: asBool(r.include_pinned_refs, false),
    include_document: asBool(r.include_document, false),
    temperature: clampNumber(r.temperature, 0.3, 0, 2),
    max_tokens:
      r.max_tokens === null || r.max_tokens === undefined
        ? null
        : Math.round(clampNumber(r.max_tokens, 0, 0, 32768)) || null,
  }
}

function normalizePreset(raw: unknown, index: number): PostProcessPreset | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const rawPasses = Array.isArray(r.passes) ? r.passes : []
  const seenPassIds = new Set<string>()
  const passes = rawPasses
    .map((pass, i) => normalizePass(pass, i))
    .filter((pass): pass is PostProcessPass => pass !== null)
    .slice(0, MAX_POST_PROCESS_PASSES)
    .map((pass) => ({ ...pass, id: uniqueId(pass.id, seenPassIds) }))
  const name = asString(r.name).trim() || `Preset ${index + 1}`
  return {
    id: asString(r.id).trim() || `preset_${index + 1}`,
    name,
    passes,
  }
}

/**
 * Sanitize a stored `post_processing` value. Unknown/missing fields fall back
 * to the starter configuration, so older settings files need no migration.
 */
export function normalizePostProcessing(raw: unknown): PostProcessingSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createDefaultPostProcessing()
  }
  const r = raw as Record<string, unknown>
  const rawPresets = Array.isArray(r.presets) ? r.presets : []
  const seenPresetIds = new Set<string>()
  let presets = rawPresets
    .map((preset, i) => normalizePreset(preset, i))
    .filter((preset): preset is PostProcessPreset => preset !== null)
    .slice(0, MAX_POST_PROCESS_PRESETS)
    .map((preset) => ({ ...preset, id: uniqueId(preset.id, seenPresetIds) }))

  if (presets.length === 0) {
    presets = [{ id: 'default', name: 'Default', passes: cloneStarterPasses() }]
  }

  const active = asString(r.active_preset).trim()
  const activeId = presets.some((p) => p.id === active) ? active : presets[0].id

  return {
    enabled: asBool(r.enabled, false),
    review: asBool(r.review, true),
    min_chars: Math.round(clampNumber(r.min_chars, 60, 0, 100_000)),
    apply_to_edit: asBool(r.apply_to_edit, true),
    apply_to_chat: asBool(r.apply_to_chat, false),
    apply_to_harness: asBool(r.apply_to_harness, true),
    active_preset: activeId,
    presets,
  }
}

/** Active preset, or the first one when `active_preset` is stale. */
export function activePostProcessPreset(
  config: PostProcessingSettings,
): PostProcessPreset {
  return (
    config.presets.find((preset) => preset.id === config.active_preset) ??
    config.presets[0]
  )
}

/** Passes that will actually run, in order. */
export function enabledPostProcessPasses(
  config: PostProcessingSettings,
): PostProcessPass[] {
  return activePostProcessPreset(config).passes.filter((pass) => pass.enabled)
}

export function postProcessingForMode(
  config: PostProcessingSettings,
  mode: 'edit' | 'chat' | 'harness',
): boolean {
  if (!config.enabled) return false
  if (mode === 'edit') return config.apply_to_edit
  if (mode === 'chat') return config.apply_to_chat
  return config.apply_to_harness
}
