import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WritingEvaluationReport } from './WritingEvaluationReport'
import type { WritingEvaluationRecord } from '../lib/writingEvaluation'

const report: WritingEvaluationRecord = {
  status: 'complete',
  result: {
    version: 1,
    deterministicChecks: [{
      id: 'non_empty',
      label: 'Draft is non-empty',
      status: 'pass',
      detail: 'The generated draft contains text.',
    }],
    modelReview: {
      summary: 'The scene follows the request.',
      criteria: [{
        id: 'instruction_adherence',
        score: 4,
        confidence: 'supported',
        rationale: 'The requested event occurs.',
        evidence: 'She reached the station.',
      }, {
        id: 'continuity', score: 4, confidence: 'limited', rationale: 'Only a short excerpt was supplied.',
      }, {
        id: 'character_consistency', score: 3, confidence: 'limited', rationale: 'Character notes are partial.',
      }, {
        id: 'plan_coverage', score: 4, confidence: 'supported', rationale: 'The supplied beats are covered.',
      }, {
        id: 'pov_tense_voice', score: 4, confidence: 'limited', rationale: 'The excerpt is short.',
      }, {
        id: 'prose_clarity', score: 4, confidence: 'supported', rationale: 'The action is clear.',
      }],
      findings: [{
        severity: 'warning',
        criterion: 'continuity',
        message: 'Check the elapsed time against the prior scene.',
      }],
    },
  },
}

describe('WritingEvaluationReport', () => {
  it('renders scores and warnings as advisory findings', () => {
    const html = renderToStaticMarkup(<WritingEvaluationReport evaluation={report} />)
    expect(html).toContain('editorial estimates')
    expect(html).toContain('4/5')
    expect(html).toContain('Check the elapsed time')
    expect(html).toContain('WARNING')
  })

  it('shows pending, failed, and disabled states without losing the draft UI', () => {
    expect(renderToStaticMarkup(<WritingEvaluationReport evaluation={null} running />)).toContain('Evaluating prose')
    expect(renderToStaticMarkup(<WritingEvaluationReport evaluation={{
      status: 'failed', message: 'Report unavailable; draft is still reviewable.',
    }} />)).toContain('draft is still reviewable')
    expect(renderToStaticMarkup(<WritingEvaluationReport evaluation={{
      status: 'skipped', reason: 'disabled',
    }} />)).toContain('turned off')
  })
})
