// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSceneDraftingAgent, createScenePlannerAgent } from './scene-agents.server'

afterEach(() => vi.unstubAllGlobals())

const endpoint = {
  model: 'test-model',
  baseUrl: 'http://localhost:1234/v1',
}

describe('scene agents', () => {
  it('limits planner reads to available files and keeps the drafter tool-free', async () => {
    const readFile = vi.fn(async () => 'outline contents')
    const planner = createScenePlannerAgent({
      endpoint,
      instructions: 'Plan the next scene.',
      availableFiles: [{ name: 'outline.md', path: 'notes/outline.md' }],
      readFile,
    })
    const drafter = createSceneDraftingAgent({
      endpoint,
      instructions: 'Draft the approved plan.',
    })

    expect(Object.keys(planner.tools)).toEqual(['read_workspace_file'])
    expect(drafter.tools ?? {}).toEqual({})

    const fileTool = planner.tools.read_workspace_file as unknown as {
      execute: (
        input: { path: string },
        options: { abortSignal?: AbortSignal },
      ) => Promise<unknown>
    }
    const abortSignal = new AbortController().signal
    expect(await fileTool.execute({ path: '../outside.md' }, { abortSignal })).toEqual({
      error: 'That file is not available in the current workspace.',
    })
    expect(readFile).not.toHaveBeenCalled()
    expect(await fileTool.execute({ path: 'notes/outline.md' }, { abortSignal })).toEqual({
      path: 'notes/outline.md',
      content: 'outline contents',
    })
    expect(readFile).toHaveBeenCalledWith('notes/outline.md')
  })

  it('streams a drafting-agent response through the configured OpenAI-compatible endpoint', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      {
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'The scene opens at dusk.' }, finish_reason: null },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
      },
    ]
    const body = [
      ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
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

    const agent = createSceneDraftingAgent({ endpoint, instructions: 'Draft the approved plan.' })
    const result = await agent.stream({ prompt: 'Draft the scene.' })
    const streamed: string[] = []
    for await (const chunk of result.textStream) streamed.push(chunk)

    expect(streamed.join('')).toBe('The scene opens at dusk.')
    await expect(result.text).resolves.toBe('The scene opens at dusk.')
  })

  it('executes a planner file-read tool and continues the agent loop', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role?: string }>
      }
      const afterTool = requestBody.messages?.some((message) => message.role === 'tool')
      const events = afterTool
        ? [
            {
              choices: [
                { index: 0, delta: { role: 'assistant', content: 'The outline makes the reveal clear.' }, finish_reason: null },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          ]
        : [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'read_1',
                        type: 'function',
                        function: {
                          name: 'read_workspace_file',
                          arguments: '{"path":"notes/outline.md"}',
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ]
      const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(body))
            controller.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const readFile = vi.fn(async () => 'She finds the sealed letter.')
    const agent = createScenePlannerAgent({
      endpoint,
      instructions: 'Use the file tool when the outline is needed.',
      availableFiles: [{ name: 'outline.md', path: 'notes/outline.md' }],
      readFile,
    })

    const result = await agent.stream({ prompt: 'What does the outline reveal?' })
    const streamed: string[] = []
    for await (const chunk of result.textStream) streamed.push(chunk)

    expect(readFile).toHaveBeenCalledWith('notes/outline.md')
    expect(streamed.join('')).toBe('The outline makes the reveal clear.')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
