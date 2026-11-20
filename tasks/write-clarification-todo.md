# Write-Mode Clarification TODO

## Clarifying agent

- [x] Verify the installed AI SDK supports unanswered tools and resuming an agent with a tool result.
- [x] Add an `ask_user` tool for one or more concise clarification questions, optional context, and radio options; leave it without a server-side `execute` function.
- [x] Add a server-side `proceed_to_plan` tool for requests that need no clarification or have been clarified.
- [x] Instruct the agent to ask only when missing information would materially affect the writing, using the request and supplied story context to decide.
- [x] Validate model-generated questions and bound the number of questions and options.

## Server pause and resume

- [x] Run the clarifying agent before the existing write planner stage.
- [x] When `ask_user` is called, emit a questionnaire SSE event and pause before starting any write stages.
- [x] Store the pending clarification turn, tool-call history, original request context, and session association under an opaque ID with an expiry.
- [x] Accept submitted answers as the tool result and resume the clarifying agent.
- [x] If the agent asks further questions, send another questionnaire; if it proceeds, start the write pipeline with the answers included in context.
- [x] Clear pending clarification state on completion, expiry, cancellation, and session deletion.

## Questionnaire UI

- [x] Connect the existing custom SSE flow to the agent's questionnaire tool call; avoid a `useChat` migration unless required by the SDK's resume behavior.
- [x] Show one radio question at a time in the popover, with Back/Next navigation and required answers.
- [x] Include an **Other** radio option for every question and show a freeform answer field when selected.
- [x] Submit answers with the clarification ID and prevent duplicate submissions.
- [x] Preserve the original request, selected passage, and referenced-file context while clarification is pending.
- [x] Show clear progress while clarification is being considered and while the questionnaire is awaiting answers.

## Tests and verification

- [x] Add coverage for clear requests, ambiguous requests, pause-before-planning, and resuming into the write stages.
- [x] Add coverage for another clarification round, freeform answers, invalid IDs/answers, expiry, and cancellation cleanup.
- [ ] Run relevant tests and verify no write stage starts before clarification is complete.

> Validation note: the installed AI SDK v7 declarations confirm that tools without `execute` pause with pending tool results, and `ToolLoopAgent` accepts resumed model-message histories. Runtime tests could not run because the `node` executable is unavailable; targeted `git diff --check` passes.
