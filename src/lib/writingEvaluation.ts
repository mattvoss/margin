import { z } from 'zod'

export const writingEvaluationCriteria = [
  'instruction_adherence',
  'continuity',
  'character_consistency',
  'plan_coverage',
  'pov_tense_voice',
  'prose_clarity',
] as const

export const writingEvaluationCriterionSchema = z.object({
  id: z.enum(writingEvaluationCriteria),
  score: z.number().int().min(1).max(5),
  confidence: z.enum(['supported', 'limited', 'insufficient_context']),
  rationale: z.string().trim().min(1).max(500),
  evidence: z.string().max(500).optional(),
})

export const writingEvaluationFindingSchema = z.object({
  severity: z.enum(['note', 'warning']),
  criterion: z.enum(writingEvaluationCriteria),
  message: z.string().trim().min(1).max(500),
  evidence: z.string().max(500).optional(),
  suggestion: z.string().max(500).optional(),
})

export const writingModelReviewSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  criteria: z.array(writingEvaluationCriterionSchema).length(writingEvaluationCriteria.length),
  findings: z.array(writingEvaluationFindingSchema).max(8),
})

export const writingDeterministicCheckSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  status: z.enum(['pass', 'warning', 'fail']),
  detail: z.string().min(1).max(500),
  evidence: z.string().max(500).optional(),
})

export const writingPredictablePatternSpanSchema = z.object({
  sentence: z.string().trim().min(1).max(500),
  signal: z.enum(['repetition', 'uniform_rhythm', 'common_phrase']),
  detail: z.string().trim().min(1).max(300),
})

export const writingPredictablePatternSchema = z.object({
  version: z.literal(1),
  method: z.literal('bounded_local_pattern_diagnostic'),
  disclaimer: z.literal('This is a predictable-pattern diagnostic, not AI-authorship detection or a literary-quality score.'),
  sentenceCount: z.number().int().nonnegative().max(2000),
  predictableSentenceCount: z.number().int().nonnegative().max(2000),
  density: z.number().min(0).max(1),
  spans: z.array(writingPredictablePatternSpanSchema).max(12),
  perplexity: z.object({
    status: z.enum(['available', 'unavailable']),
    mean: z.number().positive().finite().optional(),
    tokenCount: z.number().int().nonnegative().max(100_000).optional(),
    detail: z.string().min(1).max(300),
  }).optional(),
})

export const englishStyleCheckSchema = z.object({
  id: z.enum(['sentence_length', 'sentence_length_variance', 'paragraph_length', 'word_repetition', 'sentence_starter_repetition', 'dialogue_ratio', 'dialogue_tag_usage', 'quote_style', 'adverb_usage', 'passive_voice_signal', 'fragment_density']),
  label: z.string().min(1).max(120),
  status: z.enum(['pass', 'warning', 'not_applicable']),
  detail: z.string().min(1).max(500),
  evidence: z.array(z.string().max(500)).max(12).optional(),
  count: z.number().int().nonnegative().max(2000).optional(),
  threshold: z.number().nonnegative().max(100000).optional(),
})

export const englishStyleCheckResultSchema = z.object({
  version: z.literal(1),
  language: z.literal('en'),
  disclaimer: z.string().min(1).max(300),
  checks: z.array(englishStyleCheckSchema).max(20),
  warnings: z.number().int().nonnegative().max(20),
})

export const writingEvaluationResultSchema = z.object({
  version: z.literal(1),
  deterministicChecks: z.array(writingDeterministicCheckSchema).max(12),
  modelReview: writingModelReviewSchema.nullable(),
  predictablePattern: writingPredictablePatternSchema.nullable().optional(),
  styleChecks: englishStyleCheckResultSchema.nullable().optional(),
})

export const writingEvaluationRecordSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('complete'), result: writingEvaluationResultSchema }),
  z.object({ status: z.literal('failed'), message: z.string().min(1).max(300) }),
  z.object({ status: z.literal('skipped'), reason: z.string().min(1).max(120) }),
])

export type WritingEvaluationCriterion = z.infer<typeof writingEvaluationCriterionSchema>
export type WritingEvaluationFinding = z.infer<typeof writingEvaluationFindingSchema>
export type WritingModelReview = z.infer<typeof writingModelReviewSchema>
export type WritingDeterministicCheck = z.infer<typeof writingDeterministicCheckSchema>
export type WritingPredictablePattern = z.infer<typeof writingPredictablePatternSchema>
export type EnglishStyleCheck = z.infer<typeof englishStyleCheckSchema>
export type EnglishStyleCheckResult = z.infer<typeof englishStyleCheckResultSchema>
export type WritingEvaluationResult = z.infer<typeof writingEvaluationResultSchema>
export type WritingEvaluationRecord = z.infer<typeof writingEvaluationRecordSchema>
