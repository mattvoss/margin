import { saveMemoryText, type MemoryEmbedder, type MemoryKind, type MemoryStore } from './memory.server'
import { loadLlmConfig, type LlmSettingsLike } from './llm.server'

export interface MemoryCandidate {
  kind: MemoryKind
  content: string
}

export interface ExtractAndSaveInput {
  store: MemoryStore
  workspaceKey: string
  sessionId?: string | null
  userMessage: string
  assistantMessage: string
  embed: MemoryEmbedder
  generate: (systemPrompt: string, userPrompt: string) => Promise<string>
}

export interface MemoryExtractionInput {
  userMessage: string
  assistantMessage: string
  settings?: LlmSettingsLike | null
  model?: string | null
}

export interface MemoryExtractionConfig {
  enabled: boolean
  embed: MemoryEmbedder
}

const kinds = new Set<MemoryKind>(['fact', 'preference', 'skill', 'project_context', 'instruction'])
const MAX_CANDIDATES = 5
const MAX_CONTENT_CHARS = 1000

export function parseMemoryCandidates(raw: string): MemoryCandidate[] {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { memories?: unknown }).memories)) return []

  const candidates: MemoryCandidate[] = []
  for (const value of (parsed as { memories: unknown[] }).memories) {
    if (!value || typeof value !== 'object') continue
    const kind = (value as { kind?: unknown }).kind
    const content = (value as { content?: unknown }).content
    if (typeof kind !== 'string' || !kinds.has(kind as MemoryKind)) continue
    if (typeof content !== 'string') continue
    const normalized = content.replace(/\s+/g, ' ').trim()
    if (!normalized || normalized.length > MAX_CONTENT_CHARS) continue
    candidates.push({ kind: kind as MemoryKind, content: normalized })
    if (candidates.length >= MAX_CANDIDATES) break
  }
  return candidates
}

export async function extractMemoryCandidates(input: MemoryExtractionInput): Promise<MemoryCandidate[]> {
  const userMessage = input.userMessage.trim()
  const assistantMessage = input.assistantMessage.trim()
  if (!userMessage || !assistantMessage) return []

  const client = loadLlmConfig(input.settings, input.model)
  const response = await client.generateBlocking(
    'Extract only durable user or project memories from the conversation. Return JSON only in the form {"memories":[{"kind":"fact|preference|skill|project_context|instruction","content":"..."}]}. Return an empty list when nothing should be remembered.',
    `USER:\n${userMessage}\n\nASSISTANT:\n${assistantMessage}`,
    { maxTokens: 500, temperature: 0 },
  )
  return parseMemoryCandidates(response)
}

export async function extractAndSaveMemories(input: ExtractAndSaveInput): Promise<number> {
  const systemPrompt = [
    'Extract only durable user or project memories from the conversation.',
    'Return JSON only in the shape {"memories":[{"kind":"fact|preference|skill|project_context|instruction","content":"..."}]}.',
    'Return an empty memories array when there is nothing durable. Never include secrets, credentials, or temporary details.',
  ].join(' ')
  const userPrompt = `USER:\n${input.userMessage}\n\nASSISTANT:\n${input.assistantMessage}`
  const candidates = parseMemoryCandidates(await input.generate(systemPrompt, userPrompt))
  let saved = 0
  for (const candidate of candidates) {
    await saveMemoryText(input.store, input.embed, {
      workspaceKey: input.workspaceKey,
      sessionId: input.sessionId,
      kind: candidate.kind,
      content: candidate.content,
      sourceMessage: input.userMessage,
    })
    saved += 1
  }
  return saved
}
