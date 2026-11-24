# Writing Agents Refactor and Prose Evaluation Plan

## Implementation Status

The Write flow now includes the optional predictable-pattern diagnostic, explicit non-authorship-detection framing, and user-controlled bounded rewrite candidate loop. The diagnostic is offline and conservative by default; true perplexity is calculated only when compatible token log-probabilities are supplied, otherwise it is reported as unavailable. An English-specific Style Checker is planned but not yet implemented; it will remain opt-in and separate from the general evaluator and post-processing passes. Focused validation passes; the full suite is currently blocked by an existing `api.memory.index` test import mismatch, and repository-wide lint reports unrelated baseline errors.

## Goal

Refactor Margin's writing-agent pipeline into clearer, testable agent/tool responsibilities and add programmatic evaluation for prose produced by agents. Use the referenced [Claude-Book repository](https://github.com/ThomasHoussin/Claude-Book) and [HackerNoon article](https://hackernoon.com/claude-book-a-multi-agent-framework-for-writing-novels-with-claude-code) as design references, adapting useful patterns to Margin's existing workspace, endpoint, streaming, and review model rather than copying the framework wholesale.

The system should help users understand whether generated prose follows the request and story constraints. Evaluation is advisory: it must not claim to measure literary quality objectively, silently change a manuscript, or prevent users from reviewing generated work.

## Current Architecture and Baseline

- `src/server/assist-agents.server.ts` defines the endpoint-backed SimpleAssist agents. The regular edit planner, editor, chat agent, and post-processing agent are mostly tool-free single-call agents. A parent `ToolLoopAgent` dispatches through tools.
- `src/server/assist-stream.server.ts` contains the writing flow. It runs a clarification agent and then hard-codes a serial six-stage pipeline: plan, characters, clothing, speech, plot, and prose. Stage notes are passed forward as text, and prose deltas and stage status are streamed over SSE.
- The separate Scene Planner and Scene Drafter are defined in `src/server/scene-agents.server.ts`. The planner has a bounded, read-only workspace-file tool; the drafter has no workspace-writing tools and only runs after explicit approval.
- `src/server/post-process.server.ts` already implements ordered, optional rewrite passes. These are polishing passes, not a structured evaluation system, and should remain distinct from evaluation.
- `src/lib/stream-sse.ts` translates server SSE events; `src/components/SimpleAssist.tsx` renders write-stage progress.
- Existing tests include agent tests, route-level stream/clarification coverage, and planner/drafter tests. New coverage should fit those patterns and use mocked model responses.

## Claude-Book Reference Findings and Margin Adaptation

Repository reviewed: [ThomasHoussin/Claude-Book](https://github.com/ThomasHoussin/Claude-Book), especially `README.md`, `CLAUDE.md`, `.claude/agents/chapter-planner.md`, `.claude/agents/chapter-writer.md`, `.claude/agents/style-linter.md`, `.claude/agents/character-reviewer.md`, `.claude/agents/continuity-reviewer.md`, `scripts/style/README.md`, and `scripts/detection/README.md`.

Relevant patterns in the reference:

- **Role-isolated orchestrator:** `CLAUDE.md` sequences work, supplies context, validates gates, and updates state, while explicitly delegating writing, style review, and consistency analysis to specialist agents.
- **Planner → writer → reviewers:** the chapter planner produces actionable beats; the writer follows the plan and project bible; separate reviewers assess style, character, and continuity.
- **Deterministic checks before subjective review:** the style-linter runs a technical checker first and focuses its model review on aspects the script cannot reliably verify.
- **Non-overlapping review scopes:** character review, continuity review, and style review each have explicit boundaries, report formats, and evidence expectations.
- **Findings and gates:** the orchestrator uses reviewer reports to decide whether to proceed or return to the writer, with a stated maximum of three iterations.
- **Diagnostic—not verdict—framing:** the separate perplexity tool describes itself as a diagnostic, not an AI detector or judgment. The reference also documents hardware and language assumptions for this analysis.
- **Project-specific rules:** the technical checker uses configurable thresholds, but also contains language- and project-specific assumptions such as fixed word-count/dialogue limits and an AI-signal word list.

Adaptation decisions for Margin:

- Adopt explicit role boundaries, scoped context, structured review reports, and a deterministic-first evaluation pipeline.
- Keep Margin's planner/drafter distinction and user approval model. Do not copy Claude-Book's filesystem-writing workflow: Margin's generated prose remains reviewable output, and evaluator agents must not mutate workspace files.
- Use separate evaluation dimensions for instruction/plan adherence, story continuity, character consistency, POV/tense/voice, and narrowly scoped mechanical checks. Avoid overlapping reviewer scopes.
- Keep deterministic checks language-neutral where practical. Make style rules and thresholds project-configurable; do not copy fixed English/French assumptions, arbitrary chapter length/dialogue targets, or a generic “forbidden AI words” list as universal quality rules.
- Do not adopt automatic blocking or a three-round writer/reviewer loop as the default. Margin should present evidence and advisory findings, preserve the draft, and let the writer decide what to do. Any optional revision must be explicit, bounded, and preserve the original candidate.
- Add an optional perplexity-based predictable-pattern score inspired by Claude-Book's local “AI slope” diagnostic. It must be clearly labeled as an AI-pattern diagnostic—not authorship detection, plagiarism detection, or proof of prose quality—and must be independently disableable, language/project configurable, and accompanied by false-positive caveats.
- Add an explicit AI-detection disclaimer to the evaluation UI and documentation: Margin may report predictable-pattern signals, but it must never claim to identify whether text was written by AI or a person. Do not use the signal to block, reject, rank authorship, or silently rewrite prose.
- Add an opt-in, bounded automatic rewrite loop based on the article's flagged-sentence workflow. A rewrite may target only selected predictable-pattern findings, must preserve meaning and the original candidate, must run at most three iterations per request, and must be followed by a fresh evaluation. The default remains report-only; users must explicitly enable and apply the revised candidate.

The HackerNoon article reinforces the orchestrator → planner → writer → reviewer separation and adds a structured story bible/current-state snapshot as a way to limit long-context drift. It also describes a local perplexity-based “AI slope” diagnostic, explicit non-authorship-detection caveats, and a bounded rewrite workflow for flagged sentences. Margin adopts these three patterns as optional diagnostics and user-controlled revision features: the score measures predictable patterns only, the UI must disclaim AI authorship detection, and rewriting must preserve the original candidate and remain bounded. Margin still does not copy the story-state filesystem workflow wholesale; any state snapshot must use Margin's existing scoped workspace model.

## Design Principles

1. **Writer and evaluator have distinct responsibilities.** The writer generates prose; evaluators report evidence and findings without rewriting the draft.
2. **Agent contracts are explicit.** Each stage declares its purpose, input, output type, model settings, and failure behavior.
3. **Keep the user in control.** Evaluation findings do not silently edit or reject text. Any future revision step must be bounded and opt-in.
4. **Preserve existing behavior unless deliberately changed.** Keep clarification, streaming, cancellation, endpoint configuration, workspace isolation, post-processing, and manuscript review working.
5. **Treat scores as signals, not truth.** Report criteria, evidence, uncertainty, and the limitations of perplexity. Avoid a single unexplained “quality” score and never present predictable-pattern signals as authorship detection.
6. **Bound cost and latency.** Evaluation should have explicit token/time limits and be independently disableable or skippable.
7. **Keep deterministic tests offline.** CI and the normal test suite must not depend on paid or locally hosted model calls.
8. **Use Claude-Book as a reference, not an authority.** Document which patterns are adopted, adapted, or rejected and why.

## Proposed Target Design

### A. Agent and tool orchestration

Replace the inline stage tuple/loop in `assist-stream.server.ts` with a dedicated writing-pipeline module and typed contracts. Keep the existing parent orchestrator model where it is already appropriate; do not turn every prompt into a free-form autonomous agent.

The writing pipeline should:

- Define named stage descriptors for planning, story-constraint analysis, and drafting. Preserve useful existing analysis responsibilities, but consolidate or split stages based on the Claude-Book review and observed redundancy.
- Pass structured stage artifacts (for example, scene intent, continuity constraints, and draft text) instead of relying exclusively on concatenated free-form notes.
- Define which stages are required and which may be skipped, and enforce a bounded execution order.
- Keep tools narrow and permissioned. Any workspace read capability must be read-only and scoped to the current request's available files; writing agents must not gain filesystem mutation tools.
- Keep stage errors explicit. Decide which failures are fatal, which allow a safe fallback, and how the user is informed; do not silently treat missing stage output as success.
- Retain cancellation/abort checks between stages and ensure partial streams close cleanly.
- Keep regular SimpleAssist edit/chat, scene planning/drafting, and post-processing behavior separate unless the refactor demonstrates a concrete shared abstraction.

### B. Prose evaluation

Add an evaluation module with two complementary parts:

#### Deterministic checks

Use inexpensive, reproducible checks for objectively testable conditions, such as:

- Draft is non-empty and within configured hard safety limits (for example, maximum output size).
- Output does not contain obvious wrapper material such as an unsolicited markdown fence or agent-stage heading when prose-only output was requested.
- For replace operations, output does not reproduce surrounding text that the writer prompt forbids echoing. Use normalized exact/near-exact overlap checks conservatively to minimize false positives.
- Explicit user constraints that can be checked mechanically (for example, required/forbidden literal strings or a requested word-count interval), but only when the request or structured plan exposes them unambiguously.
- Output is valid for any machine-readable stage contract that is intended for downstream use.

Each check should return an ID, pass/warn/fail state, concise explanation, and optional evidence. Avoid brittle heuristics that label subjective style choices as objective failures.

#### Structured evaluator agent

Add a bounded evaluator agent that receives the user request, relevant plan/constraints, scoped story context, and final draft. It returns validated JSON with per-criterion ratings, evidence, and actionable findings. Initial criteria should include:

- Instruction and approved-plan adherence.
- Continuity and factual consistency with supplied context.
- POV, tense, and voice consistency where the context supports assessment.
- Coverage of requested scene beats or required elements.
- Prose clarity and coherence, presented as a subjective editorial signal.

Use an explicit schema (likely Zod) with bounded score ranges, bounded finding counts and lengths, and a clear “insufficient context”/uncertainty representation. The evaluator must not introduce new story facts, rewrite prose, or treat user-provided text as trusted instructions. Scores must be accompanied by rationale/evidence and must not be presented as objective literary truth.

#### Predictable-pattern diagnostic

Add a separate, optional diagnostic modeled on the Claude-Book `scripts/detection` tool and the HackerNoon article:

- Calculate sentence-level perplexity with a configured local or compatible endpoint when available; do not require a live detector for deterministic CI.
- Report the score and flagged sentence spans as “predictable-pattern” or “AI-slope” signals, never as an AI-authorship probability or literary-quality score.
- Keep thresholds configurable by language, genre, and project. Do not copy the reference's English/French thresholds or forbidden-word list as universal rules.
- Support additional bounded signals such as low-perplexity runs, low-variance windows, and predictable-pattern density, each with its own evidence and caveats.
- Exclude short dialogue, idioms, factual prose, and other configured exemptions where they would create predictable false positives.

#### Opt-in rewrite loop

Add a separate revision action that can consume flagged spans from the predictable-pattern diagnostic. It must preserve meaning and surrounding context, retain the original draft, produce a separate revised candidate, and stop after at most three iterations. The system must never rewrite automatically merely because a score is low; the user must explicitly enable the action and choose whether to apply the revised candidate.

#### Evaluation policy

- Run deterministic checks and the model evaluator for the agentic writing flow when evaluation is enabled.
- Make evaluation independently disableable and provide a safe failure path: a failed evaluator must not erase the draft or fail the writing request.
- Default to report-only behavior. Do not automatically block or reject a draft based on evaluator or predictable-pattern scores.
- The optional rewrite loop must be explicitly enabled, preserve the original draft for comparison, target only evidence-backed flagged spans, and run at most three iterations. Re-evaluate the revised candidate after the loop; do not create an unbounded “write until score passes” loop.
- Display an AI-detection disclaimer wherever the predictable-pattern score or rewrite controls appear.
- Use the configured endpoint by default unless the settings model already supports a distinct evaluator endpoint; do not add a separate endpoint preference without checking product conventions and the reference design.

### C. Streaming, UI, and persistence

- Add SSE events for evaluation start, completion, and recoverable failure. Completion should contain the structured result, not reasoning traces.
- Update `src/lib/stream-sse.ts` and `src/components/SimpleAssist.tsx` to show that evaluation is running and to display a compact, expandable report with criteria, findings, and deterministic checks.
- Preserve the generated prose even when evaluation fails or reports warnings.
- Persist bounded evaluation metadata in the existing AI log format so users can inspect results and tests can verify behavior. Avoid storing duplicate full prompts or unbounded evaluator output if existing logs already retain the relevant request/output.
- Persist the bounded predictable-pattern diagnostic separately from model-review criteria, including its model/configuration version, thresholds, flagged spans, and disclaimer state. Do not persist an “AI probability” field.
- Show an explicit opt-in rewrite control that preserves and compares original and revised candidates; never replace the manuscript silently.
- Keep existing post-processing statuses distinct. If evaluation runs before or after post-processing, explicitly decide and document which exact text is evaluated. Recommended initial sequence: draft → configured post-processing, if this flow supports it → evaluate the final candidate shown to the user.

## Implementation Phases and TODO

### Phase 0 — Reference review and design checkpoint

- [x] Read the Claude-Book repository; record its orchestrator, planner/writer/reviewer boundaries, deterministic-first style checks, report/gate pattern, and diagnostic-only perplexity framing.
- [x] Read the HackerNoon article and note any relevant details not represented in the repository.
- [x] Compare the repository design with Margin's existing agent, tool, prompt, context, and SSE patterns.
- [x] Write an adoption note: explicit roles, deterministic-first checks, scoped findings, configurable rules, and no default automatic blocking/revision loop.
- [x] Confirm evaluation criteria and enablement using existing settings conventions: evaluation is on by default and has a server-synced toggle in the Assist mode/model dropdown.
- [x] Confirm evaluation ordering: dedicated Write mode currently has no post-processing pass; evaluate its final prose candidate after drafting and before completion.

**Checkpoint:** The target stage graph, data contracts, and evaluation policy are agreed before implementation.

### Phase 1 — Agent contract and pipeline refactor

- [x] Add `src/server/writing-pipeline.server.ts` for writing-stage definitions and orchestration.
- [x] Define typed stage IDs, inputs, outputs, and stage result/error contracts.
- [x] Replace the inline hard-coded stage loop in `src/server/assist-stream.server.ts` with the pipeline module.
- [x] Retain the six current stage responsibilities as distinct specialist roles; defer consolidation until output-quality comparison.
- [x] Bound non-prose stage artifacts and pass labeled artifacts forward.
- [x] Preserve the current clarification gate and ensure no writing stage starts while clarification is pending.
- [x] Preserve endpoint model, temperature, token budget, thinking-tag handling, telemetry, abort signal, and reasoning/prose event behavior.
- [x] Keep writer agents free of file mutation tools.
- [x] Add isolated tests for stage ordering, artifact propagation, stage failure, and cancellation.

**Checkpoint:** Refactored pipeline produces the same user-visible draft flow, and all writing-stage behavior can be tested independently of the SSE route.

### Phase 2 — Deterministic evaluation engine

- [x] Add pure deterministic prose checks in `src/server/writing-evaluation.server.ts`.
- [x] Define a versioned evaluation result schema in `src/lib/writingEvaluation.ts`.
- [x] Implement empty/size/output-wrapper checks.
- [x] Implement conservative normalized long-exact-phrase echo detection against adjacent paragraphs.
- [x] Do not infer mechanical constraints from vague requests or add brittle language-specific style rules.
- [x] Add unit tests for empty output, wrappers, exact echoes, and short-overlap behavior.
- [x] Keep checks deterministic, bounded, and free of network/filesystem calls.

**Checkpoint:** Deterministic checks produce stable results with no model or network dependency.

### Phase 3 — Structured evaluator agent

- [x] Add `createWriteEvaluationAgent` as a single-call, tool-free evaluator using the configured endpoint.
- [x] Create and validate a bounded structured-output schema; malformed output is treated as evaluator failure.
- [x] Label/escape request, plan, context, and draft as reference data; instruct the evaluator not to rewrite or invent facts.
- [x] Bound evaluator input and output and use a 45-second timeout linked to request cancellation.
- [x] Keep deterministic checks separate from model criteria/findings and confidence.
- [x] Add mocked route tests for valid results and malformed output with safe fallback; add parser/schema tests.
- [x] Do not expose evaluator reasoning in the result or logs.

**Checkpoint:** Evaluator results are schema-validated, bounded, and advisory; evaluator failure never discards prose.

### Phase 4 — SSE, UI, settings, and logs

- [x] Define SSE events for evaluation start, completion, failure, and disabled/skipped state.
- [x] Emit evaluation after the final prose candidate is ready.
- [x] Extend `src/lib/stream-sse.ts` and event types with additive evaluation events.
- [x] Show progress and an expandable report in `SimpleAssist`; also show saved reports with session logs.
- [x] Label model scores as editorial estimates and deterministic checks as narrow tests.
- [x] Add the server-synced `write_evaluation_enabled` setting and an Assist dropdown checkbox; evaluation is enabled by default.
- [x] Store bounded evaluation metadata in existing AI logs, including the predictable-pattern diagnostic without an AI-probability field.
- [x] Keep evaluation report-only by default; optional rewrite candidates do not modify editor text or bypass review.
- [x] Add report component tests and SSE event tests.

**Checkpoint:** Users can see and inspect the evaluation while retaining full control over the manuscript.

### Phase 5 — Route integration, regression coverage, and documentation

- [x] Add route tests for write/evaluation SSE success and evaluator failure fallback.
- [x] Retain clarification pause/resume coverage and disable evaluation in those focused legacy tests.
- [x] Add pipeline cancellation coverage; evaluation cancellation uses the request signal and aborted runs are not saved as completed.
- [x] Cover evaluator failure and confirm prose still completes and remains reviewable.
- [x] Cover predictable-pattern diagnostics, perplexity calculation from supplied log-probabilities, and the three-iteration rewrite bound.
- [ ] Run the existing edit/chat/planner/drafter/post-process regression suite (blocked by the existing `src/server/api-routes.test.ts` import of missing `../routes/api.memory.index`; repository contains `api.memory.index.index.ts`).
- [x] Add deterministic evaluation fixtures in unit tests; do not assert subjective scores as objective quality.
- [x] Omit a live evaluation command from the first implementation; normal CI remains offline.
- [x] Update `docs/ai-assist.md` and `docs/writing-guide.md` with agent responsibilities, criteria, limitations, settings, and failure behavior.
- [x] Run focused Vitest tests (18/18) and `npm run build` successfully.
- [ ] Run full `npm test` (blocked by the existing `api.memory.index` test import mismatch) and repository-wide `npm run lint` (blocked by 41 unrelated baseline errors; targeted changed-file lint passes).
- [x] Bound prompts, stage artifacts, schema output, and evaluator report; keep reasoning out of evaluation logs.

**Checkpoint:** Existing features remain intact, documentation matches behavior, and all automated verification passes.

### Phase 6 — English Style Checker

Add a pure, deterministic English-language checker at `src/server/english-style-checker.server.ts`. It must not call a model, read files, mutate the workspace, rewrite prose, block output, or calculate an aggregate quality score.

#### Contract and bounds

- [x] Add versioned `styleChecks` schemas and types to `src/lib/writingEvaluation.ts`.
- [x] Use `language: 'en'`, bounded check IDs, and `pass | warning | not_applicable` statuses.
- [x] Bound results to 20 checks, 12 evidence snippets per check, 2,000 sentences, and 100,000 characters.
- [x] Include label, detail, optional evidence, count, and threshold; do not expose a combined style score.
- [x] Add a disclaimer that these are configurable English editing signals, not objective literary-quality or authorship judgments.

#### Pure checks

- [x] Sentence length and unusually long sentence signals.
- [x] Sentence-length variance, distinct from the broader predictable-pattern diagnostic.
- [x] Paragraph word-count signals.
- [x] Repeated non-stopwords in a bounded local window, with configurable ignored words.
- [x] Repeated sentence starters with case/punctuation normalization.
- [x] Conservative dialogue detection for straight and curly English quotation marks.
- [x] Dialogue ratio reporting without a default target.
- [x] Dialogue-tag counts; do not treat `said` or `asked` as bad by default.
- [x] Possible passive-voice heuristic, explicitly labeled as uncertain.
- [x] `-ly` adverb count/density, informational unless configured.
- [x] Mixed English quotation-style detection.
- [x] Conservative fragment-density signal, accounting for intentional prose rhythm.
- [ ] Keep headings, contractions, dialogue, names, refrains, and configured exclusions from producing avoidable false positives.

#### Configuration and integration

- [x] Add server-synced `english_style_checker_enabled`, defaulting to `false`.
- [ ] Keep initial thresholds in typed options/rules rather than adding many global settings.
- [x] Run checks after deterministic prose checks and before the structured model review completes.
- [x] Add `styleChecks` to the existing `write_evaluation_completed` payload and persisted `writing_evaluation.result`.
- [ ] Preserve the draft and complete evaluation safely if the checker fails.
- [ ] Do not parse arbitrary prose in `styles/STYLES.md` as executable rules in the first version.
- [ ] Add a later validated explicit style-rule block for thresholds, dialogue ratio, ignored words, quote style, and opt-in warnings.

#### UI and documentation

- [x] Add an expandable “English style checks” section to `WritingEvaluationReport`.
- [x] Display warning counts, status, thresholds, concise evidence, and limitations.
- [ ] Avoid “bad writing,” “must fix,” “AI writing,” and aggregate quality language.
- [ ] Add the opt-in setting to the Assist mode/model dropdown.
- [ ] Document the checker separately from model review, predictable-pattern diagnostics, and post-processing.

#### Tests and validation

- [x] Add `src/server/english-style-checker.server.test.ts` for sentence, paragraph, repetition, dialogue, quote, passive-voice, adverb, fragment, configuration, and bounds behavior.
- [ ] Add false-positive tests for contractions, dialogue, headings, intentional repetition, names, and fragments.
- [ ] Add schema tests for invalid IDs, excessive evidence, invalid language, and aggregate-score rejection.
- [ ] Add UI tests for the section, disclaimer, evidence, and no aggregate score.
- [ ] Add SSE, route, persistence, and settings tests for enabled, disabled, and failure-safe behavior.
- [ ] Run focused style/evaluation tests, existing Assist/SSE regressions, targeted lint, and build.

**Checkpoint:** English style signals are opt-in, deterministic, bounded, evidence-based, and unable to alter or block manuscript prose.

## Acceptance Criteria

- Writing stages have explicit, testable contracts and no longer depend on one opaque inline stage loop.
- The selected Claude-Book-inspired patterns and non-adopted patterns are documented with rationale.
- Agent-generated prose receives reproducible deterministic checks and a validated structured evaluation when enabled.
- Evaluation describes criteria and findings; it does not claim objective literary quality or silently rewrite/block prose.
- Evaluation can fail, be disabled, or be cancelled without losing an otherwise completed draft.
- No unbounded agent, evaluator, or revision loop is introduced.
- The user retains control over whether generated or revised prose is applied.
- Existing clarification, editing, chat, planner/drafter, post-processing, streaming, and workspace isolation behavior passes regression tests.
- English Style Checker results are opt-in, deterministic, bounded, configurable, and clearly distinguished from AI-authorship detection and literary-quality judgments.
- Normal CI tests require no live model endpoint or credentials.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Multiple writing stages repeat analysis or contradict one another | Higher latency/cost and inconsistent drafts | Review the reference, use explicit contracts, consolidate redundant stages, and test artifact handoff. |
| Model evaluator is inconsistent or overconfident | Users may over-trust or disregard feedback | Show criteria, evidence, and uncertainty; label model judgment as advisory; avoid one opaque aggregate score. |
| Heuristic echo checks flag valid repeated language | Unnecessary warnings or reduced trust | Keep matching conservative, scope it to replacement edits, explain evidence, and test quotations/refrains/common phrases. |
| Evaluation adds substantial latency or cost | Poor writing flow | Bound context/output/time, provide disable/skip behavior, and avoid automatic revision by default. |
| Evaluator sees unrelated/private workspace material | Privacy and context leakage | Reuse the request's scoped context; send only content needed to evaluate this draft. |
| Evaluation events break older clients or streams | UI or generation regression | Keep SSE handling additive and tolerate unknown/missing events. |
| Refactor changes scene planning or endpoint edit behavior unintentionally | Regressions outside the requested writing flow | Keep those flows separate and add regression tests before sharing abstractions. |
| Evaluation is confused with post-processing | User cannot tell whether text changed | Keep event types and UI distinct; evaluate the exact candidate presented for review and document ordering. |
| English style heuristics create false positives | Users distrust or disable the checker | Use conservative signals, distinguish warnings from failures, support exclusions and explicit thresholds, and test dialogue, names, contractions, headings, refrains, and fragments. |
| English rules are applied to non-English or multilingual prose | Incorrect or noisy feedback | Keep the checker explicitly opt-in with `language: 'en'`; do not enable it from general evaluation alone. |

## Open Decisions

- [x] Adopt Claude-Book's role isolation, deterministic-first checks, scoped findings, and explicit review criteria; do not adopt filesystem mutation or default hard gates.
- [x] Enable evaluation by default, with a persistent toggle in the Assist mode/model dropdown.
- [x] Keep the shipped evaluation report-only by default; predictable-pattern revision suggestions are opt-in and never silently applied.
- [x] Add the optional predictable-pattern diagnostic with explicit non-authorship-detection framing; calculate true perplexity only from supplied token log-probabilities.
- [x] Add the opt-in bounded rewrite loop, preserving the original candidate and limiting each request to three iterations.
- [x] Use the writer's configured endpoint for evaluation; defer a separate evaluator endpoint.
- [x] Retain the existing six writing stages as typed specialists; consider consolidation only after output evaluation.
- [x] Store the bounded evaluation report alongside the normal AI session log.
- [x] Store the bounded predictable-pattern diagnostic in the evaluation result without any AI-probability field.
- [ ] Add the opt-in English Style Checker as a separate deterministic report with no aggregate style score.
- [ ] Define and validate explicit project style rules before reading any workspace style file as configuration.
- [x] Review the HackerNoon article and record any additional relevant design constraints.
