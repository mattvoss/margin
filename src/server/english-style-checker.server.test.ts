import { describe, expect, it } from 'vitest'
import { checkEnglishStyle } from './english-style-checker.server'

describe('English style checker', () => {
  it('reports bounded sentence, paragraph, repetition, and quote signals', () => {
    const result = checkEnglishStyle({
      draft: `"Hello," she said. “Goodbye,” he said. She walked toward the window slowly and quietly before the storm arrived at the station. She walked toward the window slowly and quietly before the storm arrived at the station.\n\n${'word '.repeat(190)}`,
    })
    expect(result.language).toBe('en')
    expect(result.checks.find((check) => check.id === 'quote_style')?.status).toBe('warning')
    expect(result.checks.find((check) => check.id === 'paragraph_length')?.status).toBe('warning')
    expect(result.checks.find((check) => check.id === 'sentence_starter_repetition')?.status).toBe('pass')
    expect(result.disclaimer).toContain('not objective')
  })

  it('supports opt-in heuristic warnings and ignored words', () => {
    const result = checkEnglishStyle({
      draft: 'The device was opened carefully. The device was opened slowly.',
      rules: { warnPassiveVoice: true, warnAdverbs: true, ignoreWords: ['device'] },
    })
    expect(result.checks.find((check) => check.id === 'passive_voice_signal')?.status).toBe('warning')
    expect(result.checks.find((check) => check.id === 'adverb_usage')?.status).toBe('warning')
    expect(result.checks.find((check) => check.id === 'word_repetition')?.status).toBe('pass')
  })

  it('does not treat contractions as dialogue and handles empty input', () => {
    const empty = checkEnglishStyle({ draft: '' })
    expect(empty.checks[0]?.status).toBe('not_applicable')
    const prose = checkEnglishStyle({ draft: "I don't know. It's late." })
    expect(prose.checks.find((check) => check.id === 'quote_style')?.status).toBe('pass')
  })
})
