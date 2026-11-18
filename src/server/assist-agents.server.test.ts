// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import {
  createAssistChatAgent,
  createAssistEditAgent,
  createAssistOrchestratorAgent,
  createAssistPostProcessAgent,
} from './assist-agents.server'

afterEach(() => vi.unstubAllGlobals())

const endpoint = {
  model: 'test-model',
  baseUrl: 'http://localhost:1234/v1',
}

function completion(message: Record<string, unknown>, finishReason = 'stop') {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function stream(chunks: unknown[]) {
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
    'data: [DONE]\n\n'
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

describe('SimpleAssist agents', () => {
  it('streams an editing subagent through the configured endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        stream([
          {
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'The new paragraph.' },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
          },
        ]),
      ),
    )

    const agent = createAssistEditAgent({ endpoint, instructions: 'Rewrite the paragraph.' })
    const result = await agent.stream({ prompt: 'Make it shorter.' })
    const text: string[] = []
    for await (const part of result.textStream) text.push(part)

    expect(text.join('')).toBe('The new paragraph.')
    await expect(result.text).resolves.toBe('The new paragraph.')
    expect((await result.usage).outputTokens).toBe(3)
  })

  it('streams a chat subagent through the configured endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        stream([
          {
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'A chat reply.' },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    )

    const agent = createAssistChatAgent({ endpoint, instructions: 'Chat.' })
    const result = await agent.stream({ prompt: 'Hello.' })
    await expect(result.text).resolves.toBe('A chat reply.')
  })

  it('keeps cache hints and disables thinking for post-processing subagents', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      expect(body.cache_prompt).toBe(true)
      expect(body.n_keep).toBe(64)
      expect(body.id_slot).toBe(2)
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
      return completion({ content: 'Fixed prose.' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const agent = createAssistPostProcessAgent({
      endpoint: {
        ...endpoint,
        requestBody: { cache_prompt: true, n_keep: 64, id_slot: 2 },
      },
      instructions: 'Fix the prose.',
      temperature: 0.2,
      disableThinking: true,
    })
    const result = await agent.generate({ prompt: 'Transform this.' })

    expect(result.text).toBe('Fixed prose.')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('dispatches the orchestrator tools in order and stops on finish', async () => {
    const calls: string[] = []
    const dispatch = (name: string) =>
      tool({
        description: name,
        inputSchema: z.object({}),
        execute: async () => {
          calls.push(name)
          return { ok: true }
        },
      })
    const tools = {
      plan_edit: dispatch('plan'),
      write_edit: dispatch('write'),
      post_process: dispatch('post'),
      finish: dispatch('finish'),
    }

    const sequence = ['plan_edit', 'write_edit', 'post_process', 'finish']
    let step = 0
    const fetchMock = vi.fn(async () => {
      const name = sequence[step]
      step++
      if (!name) return completion({ content: 'done' })
      return completion(
        {
          content: null,
          tool_calls: [
            {
              id: `call_${step}`,
              type: 'function',
              function: { name, arguments: '{}' },
            },
          ],
        },
        'tool_calls',
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const agent = createAssistOrchestratorAgent({
      endpoint,
      instructions: 'Dispatch the workflow.',
      tools,
    })
    await agent.generate({ prompt: 'Edit this.' })

    expect(calls).toEqual(['plan', 'write', 'post', 'finish'])
    // finish stops the loop immediately; no extra planning call is made.
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
