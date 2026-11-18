import duckdb from 'duckdb'
import { randomUUID } from 'node:crypto'

export type MemoryKind = 'fact' | 'preference' | 'skill' | 'project_context' | 'instruction'

export interface SaveMemoryInput {
  workspaceKey: string
  sessionId?: string | null
  kind: MemoryKind
  content: string
  embedding: number[]
  sourceMessage?: string | null
  sourceLogId?: string | null
}

export interface MemorySearchInput {
  workspaceKey: string
  embedding: number[]
  limit?: number
  minimumScore?: number
  kinds?: MemoryKind[]
}

export interface MemorySearchResult {
  memoryId: string
  kind: MemoryKind
  content: string
  score: number
  strength: number
  accessCount: number
}

export interface MemoryConfig {
  enabled: boolean
  databasePath: string | undefined
  embeddingUrl: string | undefined
  embeddingApiKey: string | undefined
  embeddingModel: string | undefined
  topK: number
  minimumScore: number
  maxPromptChars: number
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function env(name: string, source: Record<string, string | undefined>): string | undefined {
  const value = source[name]?.trim()
  return value || undefined
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function memoryConfig(source: Record<string, string | undefined> = process.env): MemoryConfig {
  const embeddingUrl = env('MARGIN_MEMORY_EMBEDDING_URL', source)
  return {
    enabled: ['true', '1', 'yes'].includes((source.MARGIN_MEMORY_ENABLED ?? '').toLowerCase()),
    databasePath: env('MARGIN_MEMORY_DB_PATH', source),
    embeddingUrl: embeddingUrl?.replace(/\/+$/, ''),
    embeddingApiKey: env('MARGIN_MEMORY_EMBEDDING_API_KEY', source),
    embeddingModel: env('MARGIN_MEMORY_EMBEDDING_MODEL', source),
    topK: Math.min(Math.floor(positiveNumber(source.MARGIN_MEMORY_TOP_K, 5)), 50),
    minimumScore: nonNegativeNumber(source.MARGIN_MEMORY_MIN_SCORE, 0.45),
    maxPromptChars: Math.floor(positiveNumber(source.MARGIN_MEMORY_MAX_PROMPT_CHARS, 6000)),
  }
}

export function createMemoryEmbedder(
  config: MemoryConfig,
  fetcher: FetchLike = fetch,
): (text: string) => Promise<number[]> {
  return async text => {
    if (!config.embeddingUrl || !config.embeddingModel) {
      throw new Error('memory embedding URL and model are required')
    }
    const response = await fetcher(`${config.embeddingUrl}/embeddings`, {
      method: 'POST',
      headers: {
        ...(config.embeddingApiKey ? { authorization: `Bearer ${config.embeddingApiKey}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ input: text, model: config.embeddingModel }),
    })
    if (!response.ok) throw new Error(`memory embedding request failed (${response.status})`)
    const body: unknown = await response.json()
    const embedding =
      body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: Array<{ embedding?: unknown }> }).data[0]?.embedding
        : undefined
    if (!Array.isArray(embedding) || embedding.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('memory embedding response contained an invalid vector')
    }
    validateEmbedding(embedding)
    return embedding
  }
}

export interface MemoryStore {
  all<T extends Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>
  run(sql: string, ...params: unknown[]): Promise<void>
  close(): Promise<void>
}

const MEMORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    memory_id VARCHAR PRIMARY KEY,
    workspace_key VARCHAR NOT NULL,
    session_id VARCHAR,
    kind VARCHAR NOT NULL,
    content VARCHAR NOT NULL,
    embedding DOUBLE[],
    source_message VARCHAR,
    source_log_id VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now(),
    last_accessed TIMESTAMP,
    access_count INTEGER NOT NULL DEFAULT 0,
    strength DOUBLE NOT NULL DEFAULT 1.0,
    archived BOOLEAN NOT NULL DEFAULT FALSE
  )
`

function callbackError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function all<T extends Record<string, unknown>>(
  database: duckdb.Database,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, ...params, (error, rows) => {
      if (error) {
        reject(callbackError(error))
        return
      }
      resolve(rows as T[])
    })
  })
}

function run(database: duckdb.Database, sql: string, params: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    database.run(sql, ...params, error => {
      if (error) {
        reject(callbackError(error))
        return
      }
      resolve()
    })
  })
}

function close(database: duckdb.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    database.close(error => {
      if (error) {
        reject(callbackError(error))
        return
      }
      resolve()
    })
  })
}

function validateEmbedding(embedding: number[]): void {
  if (embedding.length === 0 || embedding.some(value => !Number.isFinite(value))) {
    throw new Error('embedding must contain at least one finite number')
  }
}

function validateText(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} must not be empty`)
  return trimmed
}

function memoryId(): string {
  return `memory_${randomUUID()}`
}

export async function saveMemory(store: MemoryStore, input: SaveMemoryInput): Promise<string> {
  const workspaceKey = validateText(input.workspaceKey, 'workspaceKey')
  const content = validateText(input.content, 'content')
  validateEmbedding(input.embedding)

  const id = memoryId()
  await store.run(
    `
      INSERT INTO memories (
        memory_id, workspace_key, session_id, kind, content, embedding,
        source_message, source_log_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    id,
    workspaceKey,
    input.sessionId ?? null,
    input.kind,
    content,
    JSON.stringify(input.embedding),
    input.sourceMessage ?? null,
    input.sourceLogId ?? null,
  )
  return id
}

export async function searchMemories(
  store: MemoryStore,
  input: MemorySearchInput,
): Promise<MemorySearchResult[]> {
  const workspaceKey = validateText(input.workspaceKey, 'workspaceKey')
  validateEmbedding(input.embedding)
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 5), 50))
  const minimumScore = input.minimumScore ?? 0
  const kinds = input.kinds ?? []
  const kindFilter = kinds.length > 0 ? `AND kind IN (${kinds.map(() => '?').join(', ')})` : ''
  const rows = await store.all<{
    memory_id: string
    kind: MemoryKind
    content: string
    score: number
    strength: number
    access_count: number
  }>(
    `
      SELECT
        memory_id,
        kind,
        content,
        strength * list_cosine_similarity(embedding, ?::JSON::DOUBLE[]) AS score,
        strength,
        access_count
      FROM memories
      WHERE workspace_key = ?
        AND archived = false
        ${kindFilter}
        AND strength * list_cosine_similarity(embedding, ?::JSON::DOUBLE[]) >= ?
      ORDER BY score DESC, updated_at DESC, memory_id ASC
      LIMIT ?
    `,
    JSON.stringify(input.embedding),
    workspaceKey,
    ...kinds,
    JSON.stringify(input.embedding),
    minimumScore,
    limit,
  )

  return rows.map(row => ({
    memoryId: row.memory_id,
    kind: row.kind,
    content: row.content,
    score: Number(row.score),
    strength: Number(row.strength),
    accessCount: Number(row.access_count),
  }))
}

export async function openMemoryStore(databasePath: string): Promise<MemoryStore> {
  const database = await new Promise<duckdb.Database>((resolve, reject) => {
    const instance = new duckdb.Database(databasePath, error => {
      if (error) {
        reject(callbackError(error))
        return
      }
      resolve(instance)
    })
  })

  await run(database, MEMORY_SCHEMA, [])

  return {
    all: <T extends Record<string, unknown>>(sql: string, ...params: unknown[]) =>
      all<T>(database, sql, params),
    run: (sql: string, ...params: unknown[]) => run(database, sql, params),
    close: () => close(database),
  }
}

export function closeMemoryStore(store: MemoryStore): Promise<void> {
  return store.close()
}
