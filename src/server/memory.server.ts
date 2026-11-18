import duckdb from 'duckdb'

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
