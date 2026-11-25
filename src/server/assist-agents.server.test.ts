// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import {
  createAssistChatAgent,
  createAssistEditAgent,
  createAssistOrchestratorAgent,
  createAssistPostProcessAgent,
  createWriteClarificationAgent,
  type AssistAgentTelemetry,
} from './assist-agents.server'

afterEach(() => vi.unstubAllGlobals())

const endpoint = {
  model: 'test-model',
  baseUrl: 'http://localhost:1234/v1',
}

const memory = {
  workspaceKey: 'workspace-a',
  config: {
    enabled: false, extractionEnabled: false, databasePath: undefined,
    embeddingUrl: undefined, embeddingApiKey: undefined, embeddingModel: undefined,
    topK: 5, minimumScore: 0.45, maxPromptChars: 6000,
  },
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

  it('exposes bounded memory search only when memory context is supplied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => completion({ content: 'Planner reply.' })))
    const withoutMemory = createAssistChatAgent({ endpoint, instructions: 'Chat.' })
    expect(Object.keys(withoutMemory.tools ?? {})).toEqual([])
    const withMemory = createAssistChatAgent({ endpoint, instructions: 'Chat.', memory })
    expect(Object.keys(withMemory.tools ?? {})).toEqual(['search_memory'])
    const schema = withMemory.tools?.search_memory as unknown as { inputSchema?: { safeParse: (value: unknown) => { success: boolean } } }
    expect(schema.inputSchema?.safeParse({ query: '' }).success).toBe(false)
    expect(schema.inputSchema?.safeParse({ query: 'x'.repeat(1001) }).success).toBe(false)

    const clarificationWithoutMemory = createWriteClarificationAgent({
      endpoint,
      instructions: 'Clarify only when needed.',
    })
    expect(Object.keys(clarificationWithoutMemory.tools ?? {}).sort()).toEqual([
      'ask_user',
      'proceed_to_plan',
    ])

    const clarificationWithMemory = createWriteClarificationAgent({
      endpoint,
      instructions: 'Clarify only when needed.',
      memory,
    })
    expect(Object.keys(clarificationWithMemory.tools ?? {}).sort()).toEqual([
      'ask_user',
      'proceed_to_plan',
      'search_memory',
    ])
    const memorySchema = clarificationWithMemory.tools?.search_memory as unknown as {
      inputSchema?: { safeParse: (value: unknown) => { success: boolean } }
    }
    expect(memorySchema.inputSchema?.safeParse({ query: 'a', kinds: ['fact', 'style', 'skill', 'location', 'chapter'] }).success)
      .toBe(false)
    expect(memorySchema.inputSchema?.safeParse({ query: 'a', limit: 9 }).success).toBe(false)

    const searchMemoryTool = clarificationWithMemory.tools?.search_memory as unknown as {
      execute: (input: { query: string }, options: Record<string, unknown>) => Promise<{
        available: boolean
        note: string
      }>
    }
    const unavailable = await searchMemoryTool.execute({ query: 'old context' }, {})
    expect(unavailable.available).toBe(false)
    expect(unavailable.note).toContain('untrusted workspace context')
  })

  it('continues clarification after unavailable memory search', async () => {
    let requestCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      requestCount += 1
      if (requestCount === 1) {
        return completion({
          content: null,
          tool_calls: [{
            id: 'call-search-memory',
            type: 'function',
            function: {
              name: 'search_memory',
              arguments: JSON.stringify({ query: 'the protagonist’s relationship to the station' }),
            },
          }],
        }, 'tool_calls')
      }
      return completion({
        content: null,
        tool_calls: [{
          id: 'call-proceed',
          type: 'function',
          function: { name: 'proceed_to_plan', arguments: '{}' },
        }],
      }, 'tool_calls')
    }))

    const agent = createWriteClarificationAgent({
      endpoint,
      instructions: 'Clarify only when needed.',
      memory,
    })
    const result = await agent.generate({ prompt: 'Write a scene at the station.' })

    expect(requestCount).toBe(2)
    expect(result.staticToolCalls).toContainEqual(
      expect.objectContaining({ toolName: 'proceed_to_plan' }),
    )
  })

  it('keeps the edit writer tool-free even when memory is configured elsewhere', async () => {
    const agent = createAssistEditAgent({ endpoint, instructions: 'Rewrite the paragraph.' })
    expect(Object.keys(agent.tools ?? {})).toEqual([])
  })

  it('keeps cache hints and disables thinking for post-processing subagents', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      expect(body.cache_prompt).toBe(true)
      expect(body.n_keep).toBe(64)
      expect(body.id_slot).toBe(2)
      expect(body.chat_template_kwargs).toEqual({ custom_flag: 'kept', enable_thinking: false })
      return completion({ content: 'Fixed prose.' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const agent = createAssistPostProcessAgent({
      endpoint: {
        ...endpoint,
        requestBody: {
          cache_prompt: true,
          n_keep: 64,
          id_slot: 2,
          chat_template_kwargs: { custom_flag: 'kept' },
        },
      },
      instructions: 'Fix the prose.',
      temperature: 0.2,
      disableThinking: true,
    })
    const result = await agent.generate({ prompt: 'Transform this.' })

    expect(result.text).toBe('Fixed prose.')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('captures llama.cpp timing metadata from streamed subagent responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        stream([
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: 'Telemetry reply.',
                  reasoning_content: 'I am planning the reply.',
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
            timings: { prompt_ms: 21, prompt_n: 8, tokens_cached: 5 },
            tokens_cached: 5,
          },
        ]),
      ),
    )
    const reasoning: string[] = []
    const telemetry: AssistAgentTelemetry = {
      timings: null,
      tokensCached: null,
      pending: null,
      onReasoningDelta: (delta) => reasoning.push(delta),
    }

    const agent = createAssistChatAgent({
      endpoint: { ...endpoint, telemetry },
      instructions: 'Chat.',
    })
    const result = await agent.stream({ prompt: 'Hello.' })
    await expect(result.text).resolves.toBe('Telemetry reply.')
    await telemetry.pending

    expect(telemetry.timings).toEqual({ prompt_ms: 21, prompt_n: 8, tokens_cached: 5 })
    expect(telemetry.tokensCached).toBe(5)
    expect(reasoning.join('')).toBe('I am planning the reply.')
  })

  it('captures returned token logprobs when the provider includes them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        stream([
          {
            choices: [{
              index: 0,
              delta: { content: 'Reply.' },
              logprobs: {
                content: [
                  { token: 'Reply', logprob: -0.12 },
                  { token: '.', logprob: -0.03 },
                ],
              },
              finish_reason: null,
            }],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    )
    const telemetry: AssistAgentTelemetry = {
      timings: null,
      tokensCached: null,
      pending: null,
    }

    const agent = createAssistChatAgent({ endpoint: { ...endpoint, telemetry }, instructions: 'Chat.' })
    const result = await agent.stream({ prompt: 'Hello.' })
    await expect(result.text).resolves.toBe('Reply.')
    await telemetry.pending

    expect(telemetry.tokenLogprobs).toEqual([-0.12, -0.03])
  })

  it('pauses on ask_user and resumes the clarification loop with its tool result', async () => {
    const questions = [{
      id: 'ending',
      question: 'How should the argument resolve?',
      options: ['A quiet apology', 'A tense interruption'],
    }]
    let requestCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      requestCount++
      if (requestCount === 1) {
        return completion({
          content: null,
          tool_calls: [{
            id: 'call-ask-user',
            type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({ questions }),
            },
          }],
        }, 'tool_calls')
      }
      return completion({
        content: null,
        tool_calls: [{
          id: 'call-proceed',
          type: 'function',
          function: { name: 'proceed_to_plan', arguments: '{}' },
        }],
      }, 'tool_calls')
    }))

    const agent = createWriteClarificationAgent({ endpoint, instructions: 'Clarify only when needed.' })
    const first = await agent.generate({ prompt: 'The scene ends at the station.' })
    expect(first.toolCalls).toHaveLength(1)
    expect(first.toolCalls[0]).toMatchObject({
      toolName: 'ask_user',
      input: { questions },
    })

    const askCall = first.toolCalls[0]
    const resumed = await agent.generate({
      messages: [
        { role: 'user', content: 'The scene ends at the station.' },
        ...first.responseMessages,
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: askCall.toolCallId,
            toolName: 'ask_user',
            input: askCall.input,
            output: { type: 'json', value: { answers: { ending: 'A quiet apology' } } },
          }],
        },
      ],
    })

    expect(resumed.staticToolCalls).toContainEqual(
      expect.objectContaining({ toolName: 'proceed_to_plan' }),
    )
    expect(requestCount).toBe(2)
  })

  it('can disable model thinking for clarification tool calls', async () => {
    let requestBody: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return completion({
        content: null,
        tool_calls: [{
          id: 'call-ask-user',
          type: 'function',
          function: {
            name: 'ask_user',
            arguments: JSON.stringify({
              questions: [{
                id: 'tone',
                question: 'What tone should the scene use?',
                options: ['Horror', 'Surreal'],
              }],
            }),
          },
        }],
      }, 'tool_calls')
    }))

    const agent = createWriteClarificationAgent({
      endpoint: {
        ...endpoint,
        requestBody: { chat_template_kwargs: { enable_thinking: false } },
      },
      instructions: 'Clarify only when needed.',
    })
    const result = await agent.generate({ prompt: 'Write a scene.' })

    expect(result.toolCalls[0]).toMatchObject({ toolName: 'ask_user' })
    expect(requestBody?.chat_template_kwargs).toEqual({ enable_thinking: false })
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
