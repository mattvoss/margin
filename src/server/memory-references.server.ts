import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { isReferenceablePath } from '../lib/fileMentions'

export interface MemorySourceReference {
  path: string
  startLine: number | null
  endLine: number | null
  startOffset: number | null
  endOffset: number | null
  heading: string | null
  contentHash: string | null
}

export interface MemoryMention {
  path: string
  name: string
  managedBy: 'user' | 'indexer'
  createdAt?: string
  updatedAt?: string
}

export function sourceContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function validateMentionPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '')
  if (!isReferenceablePath(normalized) || normalized.split('/').some(part => part === '..' || part === '.') || normalized === 'outputs' || normalized.startsWith('outputs/')) {
    throw new Error('Invalid related file path')
  }
  return normalized
}

function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length
}

function headingAt(content: string, offset: number): string | null {
  let heading: string | null = null
  let cursor = 0
  for (const line of content.split('\n')) {
    if (cursor > offset) break
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line.replace(/\r$/, ''))
    if (match) heading = match[2]
    cursor += line.length + 1
  }
  return heading
}

/** Resolve a candidate's normalized text to a real source range. */
export function sourceReferenceFor(path: string, content: string, candidate: string): MemorySourceReference {
  const compact = candidate.replace(/\s+/g, ' ').trim()
  const words = compact.split(' ').filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const match = words.length > 0
    ? new RegExp(words.join('\\s+'), 'i').exec(content)
    : null
  const startOffset = match?.index ?? null
  const endOffset = match && startOffset !== null ? startOffset + match[0].length : null
  return {
    path,
    startLine: startOffset === null ? null : lineAt(content, startOffset),
    endLine: endOffset === null ? null : lineAt(content, endOffset),
    startOffset,
    endOffset,
    heading: startOffset === null ? null : headingAt(content, startOffset),
    contentHash: sourceContentHash(content),
  }
}

export function mentionForPath(path: string): MemoryMention {
  const normalized = validateMentionPath(path)
  return { path: normalized, name: basename(normalized), managedBy: 'user' }
}
