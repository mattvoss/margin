import { describe, expect, it, vi } from 'vitest'
import { extractMemoryCandidates } from './memory-extraction.server'

vi.mock('./llm.server', () => ({
  loadLlmConfig: () => ({
    generateBlocking: vi.fn().mockResolvedValue(
      '{"memories":[{"kind":"preference","content":"The user prefers concise answers."}]}',
    ),
  }),
}))

describe('extractMemoryCandidates', () => {
  it('uses the existing blocking LLM boundary and returns validated candidates', async () => {
    await expect(extractMemoryCandidates({
      userMessage: 'Please keep answers short.',
      assistantMessage: 'I will keep them concise.',
    })).resolves.toEqual([
      { kind: 'preference', content: 'The user prefers concise answers.' },
    ])
  })

  it('does not call the model for empty turns', async () => {
    await expect(extractMemoryCandidates({ userMessage: ' ', assistantMessage: 'answer' })).resolves.toEqual([])
  })
})
