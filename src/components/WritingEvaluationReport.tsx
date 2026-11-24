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

  const { deterministicChecks, modelReview, predictablePattern, styleChecks } = evaluation.result
  const warningCount = deterministicChecks.filter((check) => check.status !== 'pass').length
    + (modelReview?.findings.filter((finding) => finding.severity === 'warning').length ?? 0)
    + (styleChecks?.warnings ?? 0)
  return (
    <details className="my-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[10px] text-[var(--text-secondary)]">
      <summary className="cursor-pointer list-none px-2.5 py-2 font-medium text-[var(--text-heading)]">
        Prose review · advisory{warningCount ? ` · ${warningCount} item${warningCount === 1 ? '' : 's'} to review` : ' · no flagged issues'}
      </summary>
      <div className="flex flex-col gap-2 border-t border-[var(--border-subtle)] px-2.5 py-2">
        <p className="text-[9px] text-[var(--text-muted)]">
          Deterministic checks cover narrow rules. Model ratings are editorial estimates, not objective measures of literary quality.
        </p>
        {predictablePattern && (
          <section aria-label="Predictable pattern diagnostic">
            <h4 className="mb-1 font-medium text-[var(--text-heading)]">Predictable-pattern diagnostic</h4>
            <p className="text-[9px] text-[var(--text-muted)]">
              This is not AI-authorship detection, plagiarism detection, or a literary-quality score. It only identifies patterns worth reviewing.
            </p>
            <p>
              {predictablePattern.predictableSentenceCount}/{predictablePattern.sentenceCount} sentences flagged ({Math.round(predictablePattern.density * 100)}%).
            </p>
            {predictablePattern.perplexity && (
              <p className="text-[var(--text-muted)]">
                Perplexity: {predictablePattern.perplexity.status === 'available' && predictablePattern.perplexity.mean != null
                  ? predictablePattern.perplexity.mean
                  : 'unavailable — endpoint did not provide token log probabilities.'}
              </p>
            )}
            {predictablePattern.spans.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1">
                {predictablePattern.spans.map((span, index) => (
                  <li key={`${span.signal}-${index}`} className="text-[var(--text-muted)]">
                    <span className="font-medium">{span.signal.replace(/_/g, ' ')}</span> · {span.detail}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {styleChecks && (
          <section aria-label="English style checks">
            <h4 className="mb-1 font-medium text-[var(--text-heading)]">English style checks</h4>
            <p className="text-[9px] text-[var(--text-muted)]">{styleChecks.disclaimer}</p>
            <ul className="mt-1 flex flex-col gap-1">
              {styleChecks.checks.map((styleCheck) => (
                <li key={styleCheck.id}>
                  <span className={styleCheck.status === 'warning' ? 'font-medium text-amber-700 dark:text-amber-300' : 'text-[var(--text-muted)]'}>
                    {styleCheck.status.replace(/_/g, ' ').toUpperCase()} · {styleCheck.label}
                  </span>
                  <div>{styleCheck.detail}</div>
                  {styleCheck.evidence?.map((evidence, index) => (
                    <blockquote key={`${styleCheck.id}-${index}`} className="mt-0.5 border-l border-[var(--border)] pl-1.5 text-[var(--text-muted)]">{evidence}</blockquote>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        )}
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
