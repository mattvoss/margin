// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildChatHistoryMessages,
  buildGeneratorPrompts,
  buildHarnessEditPrompt,
  buildStaticSystem,
  cacheOptsForSession,
  composeChatMessages,
  prefixHash,
  runPlannerPrompt,
  sortUniquePaths,
  type AssistSettings,
  type SimpleAssistLogEntry,
} from './assist.server'
import { LLMClient } from './llm.server'

const settings: AssistSettings = {
  history_turns: 5,
  ignored_ref_files: [],
  pinned_ref_files: [],
}

function log(overrides: Partial<SimpleAssistLogEntry> & { instruction: string; output: string }): SimpleAssistLogEntry {
  const { instruction, output, ...rest } = overrides
  return {
    id: 'x',
    timestamp: new Date().toISOString(),
    mode: 'chat',
    session_id: 's1',
    system_prompt: '',
    user_prompt: '',
    instruction,
    output,
    success: true,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    ...rest,
  }
}

describe('prefix-cache helpers', () => {
  it('sorts and dedupes paths deterministically', () => {
    expect(sortUniquePaths(['b.md', 'a.md', 'b.md', ''])).toEqual(['a.md', 'b.md'])
  })

  it('keeps the static system head stable; preamble flip is the only mover', () => {
    const a = buildStaticSystem('base prompt', settings)
    const b = buildStaticSystem('base prompt', settings)
    expect(a).toBe(b)
    const withPreamble = buildStaticSystem('base prompt', { ...settings, prepend_thinking_preamble: true })
    expect(withPreamble).not.toBe(a)
    expect(prefixHash(a)).toBe(prefixHash(b))
  })

  it('cacheOpts default to cachePrompt:true with estimated nKeep and no slot pin', () => {
    const opts = cacheOptsForSession(settings, 's1', 'static system text here')
    expect(opts.cachePrompt).toBe(true)
    expect(opts.nKeep).toBeGreaterThan(0)
    expect(opts.slotId).toBeUndefined()
  })

  it('pins a stable slot only when explicitly enabled', () => {
    const pinned = { ...settings, llama_pin_slots: true, llama_slot_count: 4 }
    const a = cacheOptsForSession(pinned, 's1', 'sys')
    const b = cacheOptsForSession(pinned, 's1', 'sys')
    expect(a.slotId).toBe(b.slotId)
    expect(a.slotId).toBeGreaterThanOrEqual(0)
    expect(a.slotId).toBeLessThan(4)
  })
})

describe('planner prompt order (stable first)', () => {
  it('orders manifests → history → tagged → outline/anchor → instruction', () => {
    const { system, user } = runPlannerPrompt({
      content: 'para one\n\npara two',
      message: 'do the thing',
      cursorParagraphText: 'para one',
      sessionId: 's1',
      taggedFiles: ['z.md', 'a.md'],
      settings: { ...settings, planner_include_outline: true },
      logs: [],
      manifests: [{ folder: 'chars', path: 'chars/C.md', content: 'hero' }],
      plannerPrompt: 'planner base',
    })
    expect(system).toBe('planner base')
    const iCtx = user.indexOf('AVAILABLE_CONTEXT')
    const iTag = user.indexOf('TAGGED_FILES')
    const iOutline = user.indexOf('DOCUMENT_OUTLINE')
    const iAnchor = user.indexOf('ANCHOR_PARAGRAPH_TEXT')
    const iInstr = user.indexOf('USER_INSTRUCTION')
    expect(iCtx).toBeGreaterThanOrEqual(0)
    expect(iCtx).toBeLessThan(iTag)
    expect(iTag).toBeLessThan(iOutline)
    expect(iOutline).toBeLessThan(iAnchor)
    expect(iAnchor).toBeLessThan(iInstr)
    // tagged sorted regardless of input order
    expect(user.indexOf('a.md')).toBeLessThan(user.indexOf('z.md'))
  })
})

describe('writer prompt layout', () => {
  const files: Record<string, string> = {
    'chars/b.md': 'Bravo',
    'chars/a.md': 'Alpha',
  }
  const readFile = async (p: string) => files[p] ?? null

  it('keeps system frozen and files in their own message', async () => {
    const gen = await buildGeneratorPrompts({
      paragraphBefore: 'before',
      targetParagraph: 'target',
      paragraphAfter: 'after',
      query: 'rewrite it',
      contextNeeded: ['chars/b.md', 'chars/a.md'],
      availableFiles: [
        { path: 'chars/a.md', name: 'a.md' },
        { path: 'chars/b.md', name: 'b.md' },
      ],
      settings,
      writerPrompt: 'writer base',
      readFile,
    })
    expect(gen.system).toBe('writer base')
    expect(gen.user).not.toContain('writer base')
    // files message states each filename with its content, sorted, separated
    expect(gen.files).toContain('--- FILE: chars/a.md ---\nAlpha')
    expect(gen.files).toContain('--- FILE: chars/b.md ---\nBravo')
    expect(gen.files!.indexOf('chars/a.md')).toBeLessThan(gen.files!.indexOf('chars/b.md'))
    // user carries no file content — just anchor + instruction, instruction last
    expect(gen.user).not.toContain('Alpha')
    const iBefore = gen.user.indexOf('PARAGRAPH_BEFORE')
    const iInstr = gen.user.indexOf('INSTRUCTION')
    expect(iBefore).toBeGreaterThanOrEqual(0)
    expect(iBefore).toBeLessThan(iInstr)
    expect(gen.user.endsWith('rewrite it'))
  })

  it('is order-independent under shuffled planner output', async () => {
    const mk = (order: string[]) =>
      buildGeneratorPrompts({
        paragraphBefore: 'before',
        targetParagraph: '',
        paragraphAfter: 'after',
        query: 'q',
        contextNeeded: order,
        availableFiles: [
          { path: 'chars/a.md', name: 'a.md' },
          { path: 'chars/b.md', name: 'b.md' },
        ],
        settings,
        writerPrompt: 'writer base',
        readFile,
      })
    const [x, y] = await Promise.all([mk(['chars/b.md', 'chars/a.md']), mk(['chars/a.md', 'chars/b.md'])])
    expect(x.files).toBe(y.files)
    expect(x.user).toBe(y.user)
    expect(x.system).toBe(y.system)
  })

  it('omits the files message when there is no context', async () => {
    const gen = await buildGeneratorPrompts({
      paragraphBefore: 'before',
      targetParagraph: '',
      paragraphAfter: 'after',
      query: 'q',
      contextNeeded: [],
      availableFiles: [],
      settings,
      writerPrompt: 'writer base',
      readFile,
    })
    expect(gen.files).toBeNull()
  })
})

describe('chat prompt layout', () => {
  it('freezes system; files/history ship as separate messages; volatile goes last', async () => {
    const logs = [
      log({ instruction: 'first q', output: 'first a', timestamp: '2026-01-01T00:00:00.000Z' }),
      log({ instruction: 'second q', output: 'second a', timestamp: '2026-01-02T00:00:00.000Z' }),
    ]
    const built = await composeChatMessages(
      {
        content: 'before para\n\ntarget para\n\nanother para that is not adjacent',
        message: 'summarize',
        mode: 'chat',
        session_id: 's1',
        history: [],
        selected_text: null,
        cursor_paragraph_text: 'target para',
        ref_files: [{ path: 'chars/b.md' }, { path: 'chars/a.md' }],
        available_files: [],
        active_filename: 'ch1.md',
        skip_planner: true,
        harness: 'api',
      },
      {
        settings,
        chatPrompt: 'chat base',
        readFile: async (p: string) => `content-of-${p}`,
        message: 'summarize',
        logs,
      },
    )
    expect(built.system).toBe('chat base')
    // full document must NOT leak into system; anchor window goes to user
    expect(built.system).not.toContain('another para')
    expect(built.user).toContain('PARAGRAPH_AFTER')
    expect(built.user).toContain('another para that is not adjacent')
    // history as real pairs, not squashed text
    expect(built.history).toEqual([
      { role: 'user', content: 'first q' },
      { role: 'assistant', content: 'first a' },
      { role: 'user', content: 'second q' },
      { role: 'assistant', content: 'second a' },
    ])
    // files message: filenames stated, sorted, separated from the query
    expect(built.files).toContain('--- FILE: chars/a.md ---\ncontent-of-chars/a.md')
    expect(built.files).toContain('--- FILE: chars/b.md ---\ncontent-of-chars/b.md')
    expect(built.files!.indexOf('chars/a.md')).toBeLessThan(built.files!.indexOf('chars/b.md'))
    expect(built.user).not.toContain('content-of-chars/a.md')
    expect(built.user.endsWith('summarize'))
  })

  it('puts pinned files in the files message with PINNED markers', async () => {
    const built = await composeChatMessages(
      {
        content: '',
        message: 'hi',
        mode: 'chat',
        session_id: null,
        history: [],
        selected_text: null,
        cursor_paragraph_text: null,
        ref_files: null,
        available_files: [{ path: 'styles/c.md', name: 'c.md' }],
        active_filename: null,
        skip_planner: true,
        harness: 'api',
      },
      {
        settings: { ...settings, pinned_ref_files: ['styles/c.md'] },
        chatPrompt: 'chat base',
        readFile: async () => 'pinned-content',
        message: 'hi',
        includeHistory: false,
      },
    )
    expect(built.files).toContain('--- FILE (PINNED): styles/c.md ---\npinned-content')
    expect(built.user).toBe('hi')
  })
})

describe('chat history pairs', () => {
  it('skips empty turns and caps by history_turns', () => {
    const logs = [
      log({ instruction: '', output: 'stray', timestamp: '2026-01-01T00:00:00.000Z' }),
      log({ instruction: 'q', output: '', timestamp: '2026-01-02T00:00:00.000Z' }),
    ]
    const msgs = buildChatHistoryMessages('s1', { ...settings, history_turns: 1 }, logs)
    expect(msgs).toEqual([{ role: 'user', content: 'q' }])
  })
})

describe('harness edit prompt', () => {
  it('sorts tagged files and joins system + user with a fixed delimiter', () => {
    const built = buildHarnessEditPrompt({
      activePath: 'chapters/c1.md',
      taggedFiles: ['z.md', 'a.md'],
      instruction: 'fix it',
      indexLine: 'idx',
      systemPrompt: 'harness base',
    })
    expect(built.system).toBe('harness base')
    expect(built.user.indexOf('a.md')).toBeLessThan(built.user.indexOf('z.md'))
    expect(built.harnessPrompt).toBe(`${built.system}\n\n${built.user}`)
    expect(built.user.endsWith('idx'))
  })
})

describe('llm payload cache passthrough', () => {
  it('sends cache_prompt/n_keep/id_slot only when set', () => {
    const client = new LLMClient({ model: 'm', baseUrl: 'http://localhost:8080' })
    const plain = client.buildPayload('s', 'u', {})
    expect(plain).not.toHaveProperty('cache_prompt')
    expect(plain).not.toHaveProperty('n_keep')
    expect(plain).not.toHaveProperty('id_slot')
    const cached = client.buildPayload('s', 'u', { cachePrompt: true, nKeep: 42, slotId: 2 })
    expect(cached.cache_prompt).toBe(true)
    expect(cached.n_keep).toBe(42)
    expect(cached.id_slot).toBe(2)
  })
})
