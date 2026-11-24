import { describe, expect, it } from 'vitest'
import {
  buildWritingEvaluationPrompt,
  evaluateDraftDeterministically,
  parseWritingModelReview,
} from './writing-evaluation.server'

const validReview = {
  summary: 'The passage mostly follows the request.',
  criteria: [
    { id: 'instruction_adherence', score: 4, confidence: 'supported', rationale: 'The requested reconciliation occurs.' },
    { id: 'continuity', score: 4, confidence: 'limited', rationale: 'Only a short excerpt was supplied.' },
    { id: 'character_consistency', score: 3, confidence: 'limited', rationale: 'Character notes are partial.' },
    { id: 'plan_coverage', score: 4, confidence: 'supported', rationale: 'The supplied beats are present.' },
    { id: 'pov_tense_voice', score: 4, confidence: 'limited', rationale: 'The excerpt is too short to judge voice fully.' },
    { id: 'prose_clarity', score: 4, confidence: 'supported', rationale: 'The action is easy to follow.' },
  ],
  findings: [{ severity: 'note', criterion: 'continuity', message: 'Check the preceding scene for the elapsed time.' }],
}

describe('writing evaluation', () => {
  it('runs deterministic checks without a model', () => {
    const result = evaluateDraftDeterministically({
      draft: 'Here is the draft:\nA new paragraph.',
      paragraphBefore: 'The door opened and the travelers stepped into the cold station hall before dawn.',
      paragraphAfter: 'The door opened and the travelers stepped into the cold station hall before dawn.',
    })
    expect(result.find((check) => check.id === 'non_empty')?.status).toBe('pass')
    expect(result.find((check) => check.id === 'prose_only_wrapper')?.status).toBe('warning')
    expect(result.find((check) => check.id === 'surrounding_text_echo')?.status).toBe('pass')
  })

  it('flags only long exact surrounding-text echoes, not short/common overlap', () => {
    const adjacent = 'The silver bell rang twice before Mara crossed the narrow bridge beside the old mill.'
    const repeated = evaluateDraftDeterministically({
      draft: `A thought. ${adjacent}`,
      paragraphBefore: adjacent,
    })
    expect(repeated.find((check) => check.id === 'surrounding_text_echo')).toMatchObject({ status: 'warning' })

    const short = evaluateDraftDeterministically({ draft: 'She crossed the narrow bridge.', paragraphBefore: 'She crossed the narrow bridge.' })
    expect(short.find((check) => check.id === 'surrounding_text_echo')?.status).toBe('pass')
  })

  it('flags empty and over-limit output without blocking or rewriting it', () => {
    const empty = evaluateDraftDeterministically({ draft: '' })
    expect(empty.find((check) => check.id === 'non_empty')?.status).toBe('fail')
    const large = evaluateDraftDeterministically({ draft: 'a'.repeat(100_001) })
    expect(large.find((check) => check.id === 'output_size')?.status).toBe('fail')
  })

  it('parses valid JSON and rejects missing, duplicate, or out-of-range criteria', () => {
    expect(parseWritingModelReview(JSON.stringify(validReview))).toEqual(validReview)
    expect(() => parseWritingModelReview(JSON.stringify({ ...validReview, criteria: validReview.criteria.slice(1) }))).toThrow()
    expect(() => parseWritingModelReview(JSON.stringify({
      ...validReview,
      criteria: validReview.criteria.map((criterion, index) => index ? criterion : { ...criterion, score: 8 }),
    }))).toThrow()
  })

  it('bounds and labels prompt inputs as reference data', () => {
    const prompt = buildWritingEvaluationPrompt({
      instruction: 'Continue the scene.',
      plan: 'Beat 1.',
      context: 'Context facts.',
      draft: 'Draft prose.',
    })
    expect(prompt).toContain('advisory reviewer')
    expect(prompt).toContain('<user_request>')
    expect(prompt).toContain('<generated_draft>')
    expect(prompt).toContain('Do not include an aggregate score.')

    const bounded = buildWritingEvaluationPrompt({
      instruction: 'request '.repeat(2_000),
      plan: 'plan '.repeat(2_000),
      context: 'context '.repeat(2_000),
      draft: 'draft '.repeat(2_000),
      maxInputChars: 5_000,
    })
    expect(bounded.length).toBeLessThan(6_500)
  })
})
