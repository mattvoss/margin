import { describe, expect, it } from 'vitest'
import {
  buildWritingEvaluationPrompt,
  evaluateDraftDeterministically,
  parseWritingModelReview,
  evaluatePredictablePatterns,
  buildPredictablePatternRewritePrompt,
  buildAutomaticProseRevisionPrompt,
  runBoundedPatternRewrite,
  calculatePerplexity,
  attachPerplexity,
  extractTokenLogprobs,
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
  it('extracts OpenAI token log probabilities from provider metadata', () => {
    expect(extractTokenLogprobs({ openai: { logprobs: [{ token: 'A', logprob: -0.5 }, { token: 'B', logprob: -1 }] } })).toEqual([-0.5, -1])
    expect(extractTokenLogprobs({ 'llama-cpp': { logprobs: { content: [{ token: 'A', logprob: -0.25 }] } } }, 'llama-cpp')).toEqual([-0.25])
    expect(extractTokenLogprobs({ openai: { logprobs: [{ logprob: 1 }, { logprob: 'bad' }] } })).toBeNull()
    expect(extractTokenLogprobs({ other: { logprobs: [] } })).toBeNull()
  })

  it('attaches an available perplexity summary without changing the diagnostic', () => {
    const diagnostic = evaluatePredictablePatterns('The quiet room waited. The quiet room waited.')
    const result = attachPerplexity(diagnostic, [Math.log(0.5), Math.log(0.5)])
    expect(result.spans).toEqual(diagnostic.spans)
    expect(result.perplexity).toMatchObject({ status: 'available', mean: 2, tokenCount: 2 })
  })
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
    const wrapped = `Evaluation result:\n\n\`\`\`json\n${JSON.stringify(validReview)}\n\`\`\`\nHope this helps.`
    expect(parseWritingModelReview(wrapped)).toEqual(validReview)
    expect(() => parseWritingModelReview(JSON.stringify({ ...validReview, criteria: validReview.criteria.slice(1) }))).toThrow()
    expect(() => parseWritingModelReview(JSON.stringify({
      ...validReview,
      criteria: validReview.criteria.map((criterion, index) => index ? criterion : { ...criterion, score: 8 }),
    }))).toThrow()
  })

  it('normalizes keyed criteria and richer model finding severities', () => {
    const keyed = {
      ...validReview,
      criteria: Object.fromEntries(validReview.criteria.map((criterion) => [criterion.id, criterion])),
      findings: validReview.findings.map((finding) => ({ ...finding, severity: 'minor' })),
    }
    expect(parseWritingModelReview(JSON.stringify(keyed))).toMatchObject({
      criteria: expect.arrayContaining([expect.objectContaining({ id: 'continuity' })]),
      findings: [{ severity: 'note' }],
    })
  })

  it('normalizes common confidence labels from evaluator models', () => {
    const review = {
      ...validReview,
      criteria: validReview.criteria.map((criterion, index) => ({
        ...criterion,
        confidence: index === 0 ? 'high' : index === 1 ? 'medium' : 'low',
      })),
    }
    expect(parseWritingModelReview(JSON.stringify(review)).criteria.map((criterion) => criterion.confidence)).toEqual([
      'supported', 'limited', 'insufficient_context', 'insufficient_context', 'insufficient_context', 'insufficient_context',
    ])
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

  it('reports bounded predictable-pattern signals without claiming authorship detection', () => {
    const result = evaluatePredictablePatterns(
      'The door opened slowly in the dark hallway. The door opened quietly beside the old station. The door opened carefully before the storm arrived.',
    )
    expect(result.method).toBe('bounded_local_pattern_diagnostic')
    expect(result.disclaimer).toContain('not AI-authorship detection')
    expect(result.spans[0]).toMatchObject({ signal: 'repetition' })
    expect(result.density).toBeGreaterThan(0)
  })

  it('bounds rewrite iterations and preserves the original candidate', async () => {
    const calls: number[] = []
    const result = await runBoundedPatternRewrite({
      draft: 'Original.',
      maxIterations: 99,
      evaluate: (draft) => ({
        version: 1,
        method: 'bounded_local_pattern_diagnostic',
        disclaimer: 'This is a predictable-pattern diagnostic, not AI-authorship detection or a literary-quality score.',
        sentenceCount: 1,
        predictableSentenceCount: draft === 'Original.' ? 1 : 0,
        density: draft === 'Original.' ? 1 : 0,
        spans: draft === 'Original.' ? [{ sentence: 'Original.', signal: 'common_phrase', detail: 'Inspect.' }] : [],
      }),
      rewrite: async (_draft, spans, iteration) => {
        calls.push(iteration)
        expect(spans).toHaveLength(1)
        return 'Revised.'
      },
    })
    expect(result.original).toBe('Original.')
    expect(result.revised).toBe('Revised.')
    expect(result.iterations).toBe(1)
    expect(calls).toEqual([1])
  })

  it('frames pattern rewrites as editorial revisions, not authorship evasion', () => {
    const prompt = buildPredictablePatternRewritePrompt({
      draft: 'A passage.',
      spans: [{ sentence: 'A passage.', signal: 'uniform_rhythm', detail: 'Review rhythm.' }],
    })
    expect(prompt).toContain('not an attempt to evade authorship detection')
    expect(prompt).toContain('<flagged_patterns>')
  })

  it('includes actionable findings from every evaluation in the automatic revision prompt', () => {
    const prompt = buildAutomaticProseRevisionPrompt({
      draft: 'The draft.',
      instruction: 'Write a tense scene.',
      modelReview: { ...validReview, findings: [{ severity: 'warning', criterion: 'prose_clarity', message: 'Clarify the subject.', suggestion: 'Name the actor.' }] },
      deterministicChecks: [{ id: 'continuity', label: 'Continuity', status: 'warning', detail: 'Check the transition.' }],
      predictablePattern: null,
      styleChecks: { version: 1, language: 'en', disclaimer: 'Advisory.', warnings: 1, checks: [{ id: 'word_repetition', label: 'Repeated words', status: 'warning', detail: 'A word repeats.' }] },
    })
    expect(prompt).toContain('Clarify the subject.')
    expect(prompt).toContain('Check the transition.')
    expect(prompt).toContain('A word repeats.')
  })

  it('calculates perplexity from token log probabilities without treating it as authorship evidence', () => {
    expect(calculatePerplexity([Math.log(0.5), Math.log(0.5)])).toBe(2)
    expect(calculatePerplexity([])).toBeNull()
    expect(calculatePerplexity([-1, Number.NaN])).toBeCloseTo(Math.E)
  })
})
