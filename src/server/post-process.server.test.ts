import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadLlmConfig } from './llm.server'
import {
  buildPassMessages,
  runHarnessPostProcess,
  runPostProcessPipeline,
  stripCodeFences,
} from './post-process.server'
import {
  createDefaultPostProcessing,
  type PostProcessingSettings,
} from '../lib/postProcessing'
import type { AssistSettings } from './assist.server'
import type { AiLogEntry } from './sessions.server'

vi.mock('./llm.server', () => ({
  loadLlmConfig: vi.fn(),
}))

type FakeReply = string | Error

function fakeClient(replies: FakeReply[]) {
  let index = 0
  const client = {
    lastUsage: null as { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null,
    lastModelUsed: null as string | null,
    lastThinking: null as string | null,
    generateBlockingWithMessages: vi.fn(async () => {
      const reply = replies[index++]
      client.lastUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      client.lastModelUsed = `model-${index}`
      if (reply instanceof Error) throw reply
      return reply
    }),
  }
  return client
}

function configFor(
  enabledIds: string[],
  patch: Partial<PostProcessingSettings> = {},
): PostProcessingSettings {
  const config = createDefaultPostProcessing()
  return {
    ...config,
    enabled: true,
    min_chars: 0,
    ...patch,
    presets: config.presets.map((preset) => ({
      ...preset,
      passes: preset.passes.map((pass) => ({
        ...pass,
        enabled: enabledIds.includes(pass.id),
      })),
    })),
  }
}

function settingsFor(config: PostProcessingSettings): AssistSettings {
  return {
    active_endpoint: 'test',
    endpoints: {
      test: { url: 'http://localhost', api_key: 'k', model: 'm' },
    },
    post_processing: config,
  }
}

const baseContext = {
  workspaceDir: '/tmp/margin-post-process-test',
  sessionId: null,
  characterMessage: null,
  availableFiles: [],
  readFile: async () => null,
  logs: [] as AiLogEntry[],
}

beforeEach(() => {
  vi.mocked(loadLlmConfig).mockReset()
})

describe('runPostProcessPipeline', () => {
  it('runs enabled passes in order and threads the previous output', async () => {
    const config = configFor(['starter_grounding', 'starter_prose'])
    const client = fakeClient(['first pass', 'second pass'])
    vi.mocked(loadLlmConfig).mockReturnValue(client as never)

    const result = await runPostProcessPipeline({
      ...baseContext,
      settings: settingsFor(config),
      text: 'original text that is long enough',
      mode: 'edit',
    })

    expect(result.skipped).toBe(false)
    expect(result.text).toBe('second pass')
    expect(result.snapshots).toEqual(['original text that is long enough', 'first pass', 'second pass'])
    expect(result.passes.map((p) => p.status)).toEqual(['ok', 'ok'])
    expect(result.passes.map((p) => p.name)).toEqual(['Grounding', 'Prose Rhythm'])
    expect(client.generateBlockingWithMessages).toHaveBeenCalledTimes(2)
    expect(loadLlmConfig).toHaveBeenCalledTimes(2)
  })

  it('uses each pass endpoint override and falls back independently', async () => {
    const config = configFor(['starter_grounding', 'starter_validator'])
    config.presets[0].passes[0] = { ...config.presets[0].passes[0], endpoint_id: 'pass_one' }
    config.presets[0].passes[1] = { ...config.presets[0].passes[1], endpoint_id: 'pass_two' }
    const client = fakeClient(['one', 'two'])
    vi.mocked(loadLlmConfig).mockReturnValue(client as never)

    await runPostProcessPipeline({
      ...baseContext,
      settings: settingsFor(config),
      text: 'original text that is long enough',
      mode: 'edit',
    })

    expect(vi.mocked(loadLlmConfig).mock.calls.map((call) => call[1])).toEqual([
      'pass_one',
      'pass_two',
    ])
  })

  it('keeps the previous text when a pass fails and continues', async () => {
    const config = configFor(['starter_grounding', 'starter_prose'])
    const client = fakeClient([new Error('endpoint down'), 'recovered'])
    vi.mocked(loadLlmConfig).mockReturnValue(client as never)

    const result = await runPostProcessPipeline({
      ...baseContext,
      settings: settingsFor(config),
      text: 'original text that is long enough',
      mode: 'edit',
    })

    expect(result.text).toBe('recovered')
    expect(result.snapshots).toEqual(['original text that is long enough', 'recovered'])
    expect(result.passes[0].status).toBe('failed')
    expect(result.passes[0].error).toContain('endpoint down')
    expect(result.passes[1].status).toBe('ok')
  })

  it('keeps the previous text when a pass returns empty output', async () => {
    const config = configFor(['starter_grounding', 'starter_prose'])
    const client = fakeClient(['', 'after empty'])
    vi.mocked(loadLlmConfig).mockReturnValue(client as never)

    const result = await runPostProcessPipeline({
      ...baseContext,
      settings: settingsFor(config),
      text: 'original text that is long enough',
      mode: 'edit',
    })

    expect(result.text).toBe('after empty')
    expect(result.passes[0].status).toBe('empty')
    expect(result.snapshots).toEqual(['original text that is long enough', 'after empty'])
  })

  it('skips disabled pipelines without calling the endpoint', async () => {
    const config = configFor(['starter_grounding'], { enabled: false })
    const result = await runPostProcessPipeline({
      ...baseContext,
      settings: settingsFor(config),
      text: 'original text that is long enough',
      mode: 'edit',
    })
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('disabled')
    expect(result.text).toBe('original text that is long enough')
    expect(loadLlmConfig).not.toHaveBeenCalled()
  })

  it('skips when every pass is disabled', async () => {
    const config = configFor([])
    const result = await runPostProcessPipeline({
      ...baseContext,
      settings: settingsFor(config),
      text: 'original text that is long enough',
      mode: 'edit',
    })
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('no_passes')
  })

  it('skips text below the minimum character count', async () => {
    const config = configFor(['starter_grounding'], { min_chars: 500 })
    const result = await runPostProcessPipeline({
      ...baseContext,
      settings: settingsFor(config),
      text: 'too short',
      mode: 'edit',
    })
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('min_chars')
  })

  it('honours the per-mode switches', async () => {
    const chatOff = configFor(['starter_grounding'], { apply_to_chat: false })
    const off = await runPostProcessPipeline({
      ...baseContext,
      settings: settingsFor(chatOff),
      text: 'original text that is long enough',
      mode: 'chat',
    })
    expect(off.skipped).toBe(true)
    expect(off.reason).toBe('disabled')

    const chatOn = configFor(['starter_grounding'], { apply_to_chat: true })
    vi.mocked(loadLlmConfig).mockReturnValue(fakeClient(['chat output']) as never)
    const on = await runPostProcessPipeline({
      ...baseContext,
      settings: settingsFor(chatOn),
      text: 'original text that is long enough',
      mode: 'chat',
    })
    expect(on.text).toBe('chat output')
  })
})

describe('buildPassMessages', () => {
  it('wraps the text and includes only the enabled context blocks', async () => {
    const config = configFor(['starter_grounding'])
    const pass = config.presets[0].passes[0]
    const logs = [
      {
        id: '1',
        timestamp: '2026-01-01T00:00:00.000Z',
        mode: 'chat',
        session_id: null,
        system_prompt: '',
        user_prompt: '',
        output: 'previous answer',
        instruction: 'previous question',
        success: true,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    ]

    const built = await buildPassMessages(pass, 'target text', {
      ...baseContext,
      settings: settingsFor(config),
      characterMessage: 'Mara is terse.',
      upstreamSystemPrompt: 'Keep the narrator in close third person and preserve the restrained voice.',
      upstreamInstruction: 'Tighten the paragraph, but do not change the dialogue.',
      upstreamRefinedInstruction: 'Make a light edit to improve clarity; retain all dialogue verbatim.',
      anchor: {
        paragraphBefore: 'before paragraph',
        targetParagraph: 'target text',
        paragraphAfter: 'after paragraph',
        targetIdx: 1,
        replace: true,
      },
      logs,
    })

    expect(built.system).toContain('PASS-SPECIFIC EDITING GOAL:')
    expect(built.system).toContain(pass.prompt)
    expect(built.system).toContain('binding constraints')
    expect(built.user).toContain('<upstream_generation_instructions>')
    expect(built.user).toContain('UPSTREAM SYSTEM INSTRUCTIONS:\nKeep the narrator in close third person and preserve the restrained voice.')
    expect(built.user).toContain("USER'S ORIGINAL REQUEST:\nTighten the paragraph, but do not change the dialogue.")
    expect(built.user).toContain('PLANNER-REFINED REQUEST:\nMake a light edit to improve clarity; retain all dialogue verbatim.')
    expect(built.user).toContain('<characters>\nMara is terse.\n</characters>')
    expect(built.user).toContain('<scene_context>')
    expect(built.user).toContain('USER: previous question')
    expect(built.user).toContain('ASSISTANT: previous answer')
    expect(built.user).toContain('<document_context>')
    expect(built.user).toContain('before paragraph')
    expect(built.user).toContain('<text_to_transform>\ntarget text\n</text_to_transform>')
    expect(built.messages).toEqual([
      { role: 'system', content: built.system },
      { role: 'user', content: built.user },
    ])
  })

  it('omits context blocks the pass does not request', async () => {
    const config = configFor(['starter_grounding'])
    const pass = {
      ...config.presets[0].passes[0],
      include_character: false,
      include_scene: false,
      include_pinned_refs: false,
      include_document: false,
    }
    const built = await buildPassMessages(pass, 'target text', {
      ...baseContext,
      settings: settingsFor(config),
      characterMessage: 'Should not appear.',
      anchor: {
        paragraphBefore: 'before',
        targetParagraph: 'target text',
        paragraphAfter: 'after',
        targetIdx: 1,
        replace: true,
      },
      logs: [],
    })
    expect(built.user).not.toContain('<characters>')
    expect(built.user).not.toContain('<scene_context>')
    expect(built.user).not.toContain('<document_context>')
    expect(built.user).toBe('<text_to_transform>\ntarget text\n</text_to_transform>')
  })
})

describe('stripCodeFences', () => {
  it('removes a single wrapping fence', () => {
    expect(stripCodeFences('```markdown\nhello\n```')).toBe('hello')
    expect(stripCodeFences('  plain text  ')).toBe('plain text')
  })
})

describe('runHarnessPostProcess', () => {
  it('post-processes only changed paragraph hunks and keeps untouched text', async () => {
    const config = configFor(['starter_prose'])
    vi.mocked(loadLlmConfig).mockReturnValue(fakeClient(['B2 polished']) as never)

    const result = await runHarnessPostProcess({
      ...baseContext,
      settings: settingsFor(config),
      before: 'A\n\nB\n\nC',
      after: 'A\n\nB2\n\nC',
      filePath: 'draft.md',
    })

    expect(result.skipped).toBe(false)
    expect(result.text).toBe('A\n\nB2 polished\n\nC')
    expect(result.hunks).toBe(1)
    expect(result.skippedHunks).toBe(0)
    expect(result.passes).toHaveLength(1)
    expect(result.passes[0].hunk).toBe(1)
  })

  it('handles multiple hunks in document order with a moving offset', async () => {
    const config = configFor(['starter_prose'])
    const client = fakeClient(['A1 refined', 'C1 refined'])
    vi.mocked(loadLlmConfig).mockReturnValue(client as never)

    const result = await runHarnessPostProcess({
      ...baseContext,
      settings: settingsFor(config),
      before: 'A\n\nB\n\nC',
      after: 'A1\n\nB\n\nC1',
      filePath: 'draft.md',
    })

    expect(result.text).toBe('A1 refined\n\nB\n\nC1 refined')
    expect(result.hunks).toBe(2)
    expect(client.generateBlockingWithMessages).toHaveBeenCalledTimes(2)
  })

  it('skips when the harness changed nothing', async () => {
    const config = configFor(['starter_prose'])
    const result = await runHarnessPostProcess({
      ...baseContext,
      settings: settingsFor(config),
      before: 'A\n\nB',
      after: 'A\n\nB',
      filePath: 'draft.md',
    })
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('no_changes')
    expect(result.text).toBe('A\n\nB')
    expect(loadLlmConfig).not.toHaveBeenCalled()
  })

  it('skips a single sub-minimum hunk', async () => {
    const config = configFor(['starter_prose'], { min_chars: 500 })
    const result = await runHarnessPostProcess({
      ...baseContext,
      settings: settingsFor(config),
      before: 'A\n\nB',
      after: 'A\n\nB2',
      filePath: 'draft.md',
    })
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('min_chars')
  })

  it('keeps untouched text when the pass fails', async () => {
    const config = configFor(['starter_prose'])
    vi.mocked(loadLlmConfig).mockReturnValue(fakeClient([new Error('nope')]) as never)
    const result = await runHarnessPostProcess({
      ...baseContext,
      settings: settingsFor(config),
      before: 'A\n\nB',
      after: 'A\n\nB2',
      filePath: 'draft.md',
    })
    expect(result.passes[0].status).toBe('failed')
    expect(result.text).toBe('A\n\nB2')
  })
})
