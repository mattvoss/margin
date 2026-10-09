import { resolve } from 'node:path'

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

export function err(status: number, detail: string): Response {
  return Response.json({ detail }, { status })
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = (await req.json()) as unknown
    return (v ?? {}) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

export function dec(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export function promptsDir(): string {
  const env = process.env.MARGIN_PROMPTS_DIR?.trim()
  if (env) return env
  return resolve(process.cwd(), 'prompts')
}

export async function resolvePrompts(): Promise<string> {
  const { existsSync } = await import('node:fs')
  for (const c of [promptsDir(), '/app/prompts']) {
    try {
      if (existsSync(c)) return c
    } catch {
      continue
    }
  }
  return promptsDir()
}
