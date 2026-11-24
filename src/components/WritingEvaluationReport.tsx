import type { WritingEvaluationRecord } from '../lib/writingEvaluation'

export function WritingEvaluationReport(props: {
  evaluation: WritingEvaluationRecord | null
  running?: boolean
}) {
  const { evaluation, running = false } = props
  if (!evaluation && !running) return null

  if (running) {
    return (
      <div className="my-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-2 text-[10px] text-[var(--text-secondary)]">
        Evaluating prose…
      </div>
    )
  }

  if (!evaluation) return null
  if (evaluation.status === 'skipped') {
    return (
      <div className="my-2 text-[10px] text-[var(--text-muted)]">
        Prose evaluation {evaluation.reason === 'disabled' ? 'is turned off.' : 'was skipped.'}
      </div>
    )
  }
  if (evaluation.status === 'failed') {
    return (
      <div role="status" className="my-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-2 text-[10px] text-[var(--text-secondary)]">
        {evaluation.message}
      </div>
    )
  }

  const { deterministicChecks, modelReview } = evaluation.result
  const warningCount = deterministicChecks.filter((check) => check.status !== 'pass').length
    + (modelReview?.findings.filter((finding) => finding.severity === 'warning').length ?? 0)
  return (
    <details className="my-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[10px] text-[var(--text-secondary)]">
      <summary className="cursor-pointer list-none px-2.5 py-2 font-medium text-[var(--text-heading)]">
        Prose review · advisory{warningCount ? ` · ${warningCount} item${warningCount === 1 ? '' : 's'} to review` : ' · no flagged issues'}
      </summary>
      <div className="flex flex-col gap-2 border-t border-[var(--border-subtle)] px-2.5 py-2">
        <p className="text-[9px] text-[var(--text-muted)]">
          Deterministic checks cover narrow rules. Model ratings are editorial estimates, not objective measures of literary quality.
        </p>
        {modelReview && (
          <section aria-label="Editorial review">
            <p className="mb-1">{modelReview.summary}</p>
            <ul className="flex flex-col gap-1">
              {modelReview.criteria.map((criterion) => (
                <li key={criterion.id}>
                  <span className="font-medium capitalize">{criterion.id.replace(/_/g, ' ')}</span>
                  <span> · {criterion.score}/5 · {criterion.confidence.replace(/_/g, ' ')}</span>
                  <div className="text-[var(--text-muted)]">{criterion.rationale}</div>
                  {criterion.evidence && <blockquote className="mt-0.5 border-l border-[var(--border)] pl-1.5 text-[var(--text-muted)]">{criterion.evidence}</blockquote>}
                </li>
              ))}
            </ul>
          </section>
        )}
        <section aria-label="Deterministic checks">
          <h4 className="mb-1 font-medium text-[var(--text-heading)]">Deterministic checks</h4>
          <ul className="flex flex-col gap-1">
            {deterministicChecks.map((check) => (
              <li key={check.id}>
                <span className={check.status === 'fail' ? 'text-[var(--danger)]' : check.status === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-[var(--text-muted)]'}>
                  {check.status.toUpperCase()} · {check.label}
                </span>
                <div>{check.detail}</div>
                {check.evidence && <blockquote className="mt-0.5 border-l border-[var(--border)] pl-1.5 text-[var(--text-muted)]">{check.evidence}</blockquote>}
              </li>
            ))}
          </ul>
        </section>
        {modelReview?.findings.length ? (
          <section aria-label="Review findings">
            <h4 className="mb-1 font-medium text-[var(--text-heading)]">Findings</h4>
            <ul className="flex flex-col gap-1">
              {modelReview.findings.map((finding, index) => (
                <li key={`${finding.criterion}-${index}`}>
                  <span className={finding.severity === 'warning' ? 'font-medium text-amber-700 dark:text-amber-300' : 'font-medium'}>
                    {finding.severity.toUpperCase()} · {finding.criterion.replace(/_/g, ' ')}
                  </span>
                  <div>{finding.message}</div>
                  {finding.evidence && <blockquote className="mt-0.5 border-l border-[var(--border)] pl-1.5 text-[var(--text-muted)]">{finding.evidence}</blockquote>}
                  {finding.suggestion && <div className="text-[var(--text-muted)]">Suggestion: {finding.suggestion}</div>}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </details>
  )
}
