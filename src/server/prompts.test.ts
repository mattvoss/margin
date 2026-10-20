// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PromptNotFoundError,
  listPrompts,
  primaryPromptsDir,
  readPrompt,
  writePrompt,
} from './prompts.server'

const originalCwd = process.cwd()
const originalEnv = process.env.MARGIN_PROMPTS_DIR
let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'margin-prompts-test-'))
  delete process.env.MARGIN_PROMPTS_DIR
})

afterEach(() => {
  process.chdir(originalCwd)
  if (originalEnv === undefined) delete process.env.MARGIN_PROMPTS_DIR
  else process.env.MARGIN_PROMPTS_DIR = originalEnv
  rmSync(tmp, { recursive: true, force: true })
})

describe('prompt resolution', () => {
  it('reads the shipped prompts even when the working directory has no prompts folder', async () => {
    process.chdir(tmp)

    const content = await readPrompt('simple-writer.md')
    expect(content.length).toBeGreaterThan(0)
    expect(content).toContain('TASK')
  })

  it('uses MARGIN_PROMPTS_DIR for custom files and for writes', async () => {
    const dir = join(tmp, 'prompts')
    mkdirSync(dir)
    writeFileSync(join(dir, 'custom.md'), 'custom body')

    process.env.MARGIN_PROMPTS_DIR = dir
    expect(await readPrompt('custom.md')).toBe('custom body')
    expect(primaryPromptsDir()).toBe(dir)

    const saved = await writePrompt('saved.md', 'saved body')
    expect(saved).toBe(dir)
    expect(await readPrompt('saved.md')).toBe('saved body')
    expect((await listPrompts()).map((p) => p.name)).toContain('saved.md')
  })

  it('falls through to another candidate when the env directory lacks the file', async () => {
    const empty = join(tmp, 'empty')
    mkdirSync(empty)
    process.env.MARGIN_PROMPTS_DIR = empty
    process.chdir(tmp)

    const content = await readPrompt('simple-chat.md')
    expect(content.length).toBeGreaterThan(0)
  })

  it('still lists the bundled prompts when no directory has files', async () => {
    process.env.MARGIN_PROMPTS_DIR = join(tmp, 'missing')
    process.chdir(tmp)

    const names = (await listPrompts(join(tmp, 'data'))).map((p) => p.name)
    expect(names).toContain('simple-writer.md')
    expect(names).toContain('simple-planner.md')
    expect(names).toContain('simple-chat.md')
    expect(names).toContain('harness-edit.md')
  })

  it('rejects directory traversal and empty names', async () => {
    await expect(readPrompt('../secrets.md')).rejects.toBeInstanceOf(PromptNotFoundError)
    await expect(readPrompt('folder/file.md')).rejects.toBeInstanceOf(PromptNotFoundError)
    await expect(readPrompt('')).rejects.toBeInstanceOf(PromptNotFoundError)
    await expect(writePrompt('../evil.md', 'x')).rejects.toBeInstanceOf(PromptNotFoundError)
  })
})
