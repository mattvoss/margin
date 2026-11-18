import type { MemoryKind } from './memory.server'

export interface MemoryCandidate {
  kind: MemoryKind
  content: string
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
