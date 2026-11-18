// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LLMClient } from './llm.server'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LLMClient blocking responses', () => {
  it('passes aborts through without wrapping them as endpoint errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('Aborted', 'AbortError')
      }),
    )

    const client = new LLMClient({ baseUrl: 'http://mock.local/v1', model: 'mock' })
    await expect(
      client.generateBlocking('system', 'user', { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('disables thinking through chat_template_kwargs and reads content arrays', async () => {
    let seen: Record<string, unknown> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = requestBody(init)
        return jsonResponse({
          model: 'mock',
          choices: [
            {
              message: {
                content: [{ type: 'text', text: '{"characters":[]}' }],
                reasoning_content: 'deliberation',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        })
      }),
    )

    const client = new LLMClient({
      baseUrl: 'http://mock.local/v1',
      model: 'mock',
      isThinking: true,
    })
    const text = await client.generateBlocking('system', 'user', {
      enableThinking: false,
    })

    expect(text).toBe('{"characters":[]}')
    expect(client.lastThinking).toBe('deliberation')
    expect(client.lastFinishReason).toBe('stop')
    expect(client.lastContentChars).toBe(17)
    expect(seen.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('merges llama.cpp cache fields and captures timing telemetry', async () => {
    let seen: Record<string, unknown> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = requestBody(init)
        return jsonResponse({
          model: 'resolved-model',
          choices: [
            {
              message: { content: 'answer' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
          timings: { prompt_ms: 20, prompt_n: 11, predicted_ms: 6, predicted_n: 3, tokens_cached: 8 },
        })
      }),
    )

    const client = new LLMClient({ baseUrl: 'http://mock.local/v1', model: 'mock' })
    expect(
      await client.generateBlocking('system', 'user', {
        maxTokens: 90,
        cachePrompt: true,
        nKeep: 24,
        slotId: 2,
      }),
    ).toBe('answer')

    expect(seen).toMatchObject({
      cache_prompt: true,
      n_keep: 24,
      id_slot: 2,
      max_tokens: 90,
    })
    expect(client.lastModelUsed).toBe('resolved-model')
    expect(client.lastUsage).toMatchObject({ prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 })
    expect(client.lastTimings).toMatchObject({ prompt_ms: 20, predicted_n: 3 })
    expect(client.lastTokensCached).toBe(8)
  })

  it('falls back to reasoning_content only when requested', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          choices: [
            {
              message: { content: '', reasoning_content: '{"characters":[]}' },
              finish_reason: 'length',
            },
          ],
        }),
      ),
    )

    const client = new LLMClient({
      baseUrl: 'http://mock.local/v1',
      model: 'mock',
      isThinking: true,
    })

    expect(await client.generateBlocking('system', 'user')).toBe('')
    expect(client.lastFinishReason).toBe('length')
    expect(client.lastThinking).toBe('{"characters":[]}')

    expect(
      await client.generateBlocking('system', 'user', {
        fallbackToReasoning: true,
      }),
    ).toBe('{"characters":[]}')
  })
})

describe('LLMClient streaming responses', () => {
  it('streams captured reasoning through the thinking callback without mixing it into the answer', async () => {
    const encoder = new TextEncoder()
    const body = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'deliberation' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'The scene opens at dusk.' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join('')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(body))
              controller.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    )

    const client = new LLMClient({
      baseUrl: 'http://mock.local/v1',
      model: 'mock',
      isThinking: true,
    })
    const thinking: string[] = []
    const answer: string[] = []
    for await (const chunk of client.streamWithMessages(
      [{ role: 'system', content: 'system' }, { role: 'user', content: 'plan' }],
      { onThinking: (chunk) => thinking.push(chunk) },
    )) {
      answer.push(chunk)
    }

    expect(thinking.join('')).toBe('deliberation')
    expect(answer.join('')).toBe('The scene opens at dusk.')
    expect(client.lastThinking).toBe('deliberation')
  })

  it('preserves stream usage, finish reason, and llama.cpp timing chunks', async () => {
    const encoder = new TextEncoder()
    const body = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'length' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 13, completion_tokens: 4, total_tokens: 17 }, timings: { prompt_ms: 30, tokens_cached: 9 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join('')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(body))
              controller.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    )

    const client = new LLMClient({ baseUrl: 'http://mock.local/v1', model: 'mock' })
    const answer: string[] = []
    for await (const chunk of client.streamWithMessages([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
    ])) {
      answer.push(chunk)
    }

    expect(answer.join('')).toBe('Done.')
    expect(client.lastFinishReason).toBe('length')
    expect(client.lastUsage).toMatchObject({ prompt_tokens: 13, completion_tokens: 4, total_tokens: 17 })
    expect(client.lastTimings).toMatchObject({ prompt_ms: 30 })
    expect(client.lastTokensCached).toBe(9)
  })
})
