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
