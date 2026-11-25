export type AgentMode = 'write' | 'edit' | 'chat'
export type ThinkingLevel = 'low' | 'medium' | 'high'

export interface AgentSettings {
  enabled: boolean
  endpoint_id?: string
  model?: string
  thinking_enabled: boolean
  thinking_level: ThinkingLevel
  temperature: number
}

export type AgentSettingsByMode = Record<AgentMode, Record<string, AgentSettings>>

export interface AgentDefinition {
  id: string
  mode: AgentMode
  label: string
  description: string
  promptFile?: string
  required?: boolean
}

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  { id: 'plan', mode: 'write', label: 'Scene Plan', description: 'Plans the scene and its constraints.', required: false },
  { id: 'characters', mode: 'write', label: 'Characters', description: 'Checks character goals, behavior, and continuity.' },
  { id: 'clothing', mode: 'write', label: 'Physical Detail', description: 'Checks relevant appearance and physical continuity.' },
  { id: 'speech', mode: 'write', label: 'Dialogue', description: 'Plans dialogue, voice, and subtext.' },
  { id: 'plot', mode: 'write', label: 'Plot Continuity', description: 'Checks causality, stakes, and escalation.' },
  { id: 'prose', mode: 'write', label: 'Prose Writer', description: 'Writes the finished scene.', required: true },
  { id: 'clarification', mode: 'write', label: 'Clarification', description: 'Asks questions when a writing request needs decisions.' },
  { id: 'evaluator', mode: 'write', label: 'Prose Evaluator', description: 'Reviews generated prose and identifies actionable issues.' },
  { id: 'rewriter', mode: 'write', label: 'Automatic Rewriter', description: 'Applies supported evaluation findings to generated prose.' },
  { id: 'planner', mode: 'edit', label: 'Edit Planner', description: 'Chooses context and refines the edit request.', promptFile: 'simple-planner.md' },
  { id: 'writer', mode: 'edit', label: 'Editor', description: 'Writes the replacement passage.', promptFile: 'simple-writer.md', required: true },
  { id: 'chat', mode: 'chat', label: 'Chat', description: 'Answers and converses without editing.', promptFile: 'simple-chat.md', required: true },
]

const DEFAULTS: Record<AgentMode, Record<string, Omit<AgentSettings, 'endpoint_id' | 'model'>>> = {
  write: {
    plan: { enabled: true, thinking_enabled: true, thinking_level: 'medium', temperature: 0.35 },
    characters: { enabled: true, thinking_enabled: true, thinking_level: 'medium', temperature: 0.35 },
    clothing: { enabled: true, thinking_enabled: true, thinking_level: 'medium', temperature: 0.35 },
    speech: { enabled: true, thinking_enabled: true, thinking_level: 'medium', temperature: 0.35 },
    plot: { enabled: true, thinking_enabled: true, thinking_level: 'medium', temperature: 0.35 },
    prose: { enabled: true, thinking_enabled: true, thinking_level: 'high', temperature: 0.8 },
    clarification: { enabled: true, thinking_enabled: false, thinking_level: 'low', temperature: 0.2 },
    evaluator: { enabled: true, thinking_enabled: false, thinking_level: 'low', temperature: 0.1 },
    rewriter: { enabled: true, thinking_enabled: false, thinking_level: 'low', temperature: 0.1 },
  },
  edit: {
    planner: { enabled: true, thinking_enabled: true, thinking_level: 'medium', temperature: 0.3 },
    writer: { enabled: true, thinking_enabled: true, thinking_level: 'medium', temperature: 0.7 },
  },
  chat: {
    chat: { enabled: true, thinking_enabled: true, thinking_level: 'medium', temperature: 0.7 },
  },
}

export function defaultAgentSettings(): AgentSettingsByMode {
  return Object.fromEntries((Object.keys(DEFAULTS) as AgentMode[]).map((mode) => [
    mode,
    Object.fromEntries(Object.entries(DEFAULTS[mode]).map(([id, value]) => [id, { ...value }])),
  ])) as AgentSettingsByMode
}

export function normalizeAgentSettings(input: unknown): AgentSettingsByMode {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const defaults = defaultAgentSettings()
  for (const definition of AGENT_DEFINITIONS) {
    const modeSource = source[definition.mode]
    const raw = modeSource && typeof modeSource === 'object'
      ? (modeSource as Record<string, unknown>)[definition.id]
      : undefined
    const base = defaults[definition.mode][definition.id]
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const level = value.thinking_level
    defaults[definition.mode][definition.id] = {
      ...base,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : base.enabled,
      thinking_enabled: typeof value.thinking_enabled === 'boolean' ? value.thinking_enabled : base.thinking_enabled,
      thinking_level: level === 'low' || level === 'medium' || level === 'high' ? level : base.thinking_level,
      temperature: typeof value.temperature === 'number' && Number.isFinite(value.temperature)
        ? Math.min(2, Math.max(0, value.temperature))
        : base.temperature,
      ...(typeof value.endpoint_id === 'string' ? { endpoint_id: value.endpoint_id } : {}),
      ...(typeof value.model === 'string' ? { model: value.model } : {}),
    }
  }
  return defaults
}

export function agentSettingsFor(
  settings: { agents?: unknown },
  mode: AgentMode,
  id: string,
): AgentSettings {
  return normalizeAgentSettings(settings.agents)[mode][id] ?? {
    enabled: false, thinking_enabled: false, thinking_level: 'medium', temperature: 0.7,
  }
}
