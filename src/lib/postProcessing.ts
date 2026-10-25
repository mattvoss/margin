/**
 * Shared post-processing model.
 *
 * Concepts adapted from closuretxt/recast-post-processing (AGPL-3.0): an
 * ordered list of independent, individually toggleable passes, each with its
 * own prompt, model/endpoint, and context options. A pass receives the
 * previous pass's text and the upstream generation instructions so it can
 * improve prose without drifting from the requested task or voice.
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

const GROUNDING_PROMPT = `You are a conservative continuity and grounding proofreader. Make only small, local corrections when wording in <text_to_transform> clearly conflicts with supplied story facts, terminology, or setting context.

Do not add lore, explanations, imagery, actions, reactions, transition beats, or other details. Do not make prose more atmospheric or change its voice. If there is no clear contradiction, leave the text unchanged.

Return only the resulting text.`

const VALIDATOR_PROMPT = `You are a conservative character-consistency proofreader. Make a minimal correction only when dialogue or an action in <text_to_transform> clearly contradicts explicit character information or examples provided in context.

Use this evidence order: example dialogue > explicit personality traits > general description > scene context. Do not infer unstated feelings or intentions.

Do not otherwise alter voice, emotional delivery, dialogue, pacing, or sentence structure. Do not add or remove actions or details. If there is no clear contradiction, leave the text unchanged.

Return only the resulting text.`

const PROSE_PROMPT = `You are a conservative line editor. Improve readability in <text_to_transform> with small, local edits while preserving the author's established voice and wording wherever possible.

Rules:
- Preserve meaning, dialogue, events, details, point of view, and tense.
- Do not add or remove actions, reactions, imagery, or other content.
- Keep the author's diction and sentence patterns unless a local change clearly improves clarity or removes accidental awkwardness.
- Avoid changing dialogue; only correct an obvious typo or follow an explicit upstream request.

You may fix clear awkward phrasing, accidental repetition, or a sentence-level clarity issue. Do not impose a new rhythm or style. If the prose is already clear, leave it unchanged.

Return only the resulting text.`

const REPETITION_PROMPT = `Proofread <text_to_transform> for clear, accidental repetition and remove only the redundant instance with the smallest possible edit.

Rules:
- Preserve intentional emphasis, motifs, parallel phrasing, and repeated dialogue beats.
- Do not restructure sentences, change the voice, or replace the author's wording unnecessarily.
- Do not add content. If repetition is not clearly accidental, leave it unchanged.

Return only the resulting text.`

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
