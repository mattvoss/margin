/**
 * prompts.server.ts — the single source of truth for prompt template files.
 *
 * Prompt files are user-editable from Settings → Context, but the app can run
 * from a repo checkout, a Vite dev server, a Nitro `.output` bundle started
 * from an arbitrary working directory, or the Docker image. Rather than betting
 * on one location, reads walk a list of candidates and fall back to the copies
 * bundled at build time (`?raw`), so the editor never 404s just because the
 * process cwd or MARGIN_PROMPTS_DIR is unexpected.
 *
 * Writes go to one deterministic directory so edits persist:
 *   MARGIN_PROMPTS_DIR  →  <cwd>/prompts (dev checkout)  →  <DATA_ROOT>/prompts
 *
 * In Docker the image sets MARGIN_PROMPTS_DIR=/data/prompts, which lives on the
 * data volume, so edits survive container recreates. The bundled defaults stay
 * available as a read fallback.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_ROOT } from './env.server'

import harnessEditPrompt from '../../prompts/harness-edit.md?raw'
import simpleChatPrompt from '../../prompts/simple-chat.md?raw'
import simplePlannerPrompt from '../../prompts/simple-planner.md?raw'
import simpleWriterPrompt from '../../prompts/simple-writer.md?raw'

/** Build-time copies of the shipped prompts, used when no file is on disk. */
export const BUNDLED_PROMPTS: Readonly<Record<string, string>> = {
  'harness-edit.md': harnessEditPrompt,
  'simple-chat.md': simpleChatPrompt,
  'simple-planner.md': simplePlannerPrompt,
  'simple-writer.md': simpleWriterPrompt,
}

/** Prompt names are flat filenames — no directories, no traversal. */
export function isSafePromptName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !name.includes('\0')
  )
}

export class PromptNotFoundError extends Error {
  readonly promptName: string
  readonly attempts: string[]

  constructor(promptName: string, attempts: string[] = []) {
    super(`Prompt file not found: ${promptName}`)
    this.name = 'PromptNotFoundError'
    this.promptName = promptName
    this.attempts = attempts
  }
}

/** Directories the server may have been deployed next to (module-relative). */
function moduleRelativeCandidates(): string[] {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    const out: string[] = []
    // src/server → repo root is 2 levels; .output/server/_ssr → app root is 3.
    for (let i = 0; i < 6; i += 1) {
      out.push(join(dir, 'prompts'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return out
  } catch {
    return []
  }
}

function envPromptsDir(): string | null {
  const env = process.env.MARGIN_PROMPTS_DIR?.trim()
  return env ? resolve(env) : null
}

/**
 * Ordered read candidates. Existence is checked per requested file, so an
 * existing-but-incomplete directory cannot shadow the bundled defaults.
 */
export function promptDirCandidates(dataRoot: string = DATA_ROOT): string[] {
  const candidates: string[] = []
  const env = envPromptsDir()
  if (env) candidates.push(env)
  candidates.push(join(dataRoot, 'prompts'))
  candidates.push(resolve(process.cwd(), 'prompts'))
  candidates.push(...moduleRelativeCandidates())
  candidates.push('/app/prompts')

  const seen = new Set<string>()
  return candidates.filter((dir) => {
    if (seen.has(dir)) return false
    seen.add(dir)
    return true
  })
}

/**
 * Directory writes go to. Keeps the historical dev behavior (edit the repo
 * `prompts/` folder when running from a checkout) while defaulting to the
 * persistent data directory everywhere else.
 */
export function primaryPromptsDir(dataRoot: string = DATA_ROOT): string {
  const env = envPromptsDir()
  if (env) return env
  const repoDir = resolve(process.cwd(), 'prompts')
  if (existsSync(repoDir)) return repoDir
  return join(dataRoot, 'prompts')
}

/** Read one prompt file, falling back to the bundled copy. */
export async function readPrompt(name: string, dataRoot: string = DATA_ROOT): Promise<string> {
  if (!isSafePromptName(name)) {
    throw new PromptNotFoundError(name)
  }

  const attempts: string[] = []
  for (const dir of promptDirCandidates(dataRoot)) {
    const file = join(dir, name)
    attempts.push(file)
    try {
      return await readFile(file, 'utf-8')
    } catch {
      // Missing/unreadable candidate — try the next one.
    }
  }

  const bundled = BUNDLED_PROMPTS[name]
  if (bundled !== undefined) return bundled

  throw new PromptNotFoundError(name, attempts)
}

/** Write one prompt file to the primary (persistent) directory. */
export async function writePrompt(
  name: string,
  content: string,
  dataRoot: string = DATA_ROOT,
): Promise<string> {
  if (!isSafePromptName(name)) {
    throw new PromptNotFoundError(name)
  }
  const dir = primaryPromptsDir(dataRoot)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), content, 'utf-8')
  return dir
}

/** Names available on disk or bundled, sorted and de-duplicated. */
export async function listPrompts(
  dataRoot: string = DATA_ROOT,
): Promise<Array<{ name: string; path: string }>> {
  const names = new Set<string>(Object.keys(BUNDLED_PROMPTS))
  for (const dir of promptDirCandidates(dataRoot)) {
    try {
      for (const file of await readdir(dir)) {
        if (file.endsWith('.md')) names.add(file)
      }
    } catch {
      // Directory absent or unreadable — other candidates still apply.
    }
  }
  return [...names].sort().map((name) => ({ name, path: name }))
}
