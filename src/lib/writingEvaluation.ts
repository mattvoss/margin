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

export const writingEvaluationResultSchema = z.object({
  version: z.literal(1),
  deterministicChecks: z.array(writingDeterministicCheckSchema).max(12),
  modelReview: writingModelReviewSchema.nullable(),
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
export type WritingEvaluationResult = z.infer<typeof writingEvaluationResultSchema>
export type WritingEvaluationRecord = z.infer<typeof writingEvaluationRecordSchema>
