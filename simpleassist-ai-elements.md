# Plan: Refactor SimpleAssist UI to shadcn AI Elements

## Goal

Refactor the SimpleAssist conversation UI to use the shadcn AI Elements documented at <https://ui.shadcn.com/docs/ai-elements/base/chat> wherever they fit, while preserving the current SimpleAssist behavior and visual conventions. Keep `AssistMarkdown` as the assistant Markdown boundary; it already wraps Streamdown and supports static and streaming modes.

## Scope and constraints

- Focus on the SimpleAssist presentation layer and its component tests.
- Keep the `/api/assist/simple` request and SSE event contract unchanged.
- Preserve chat/edit modes, persisted session history, live streaming, reasoning display, tool activity, retry/copy/insert actions, edit review/apply, and cancellation behavior.
- Preserve the existing `@file` and editor-selection chips. They use a `contentEditable` composer, so integrate the documented prompt-input shell around it only if the AI Element can support this safely; do not regress chip insertion, removal, caret positioning, or keyboard behavior to force a textarea migration.
- Do not add a separate subagent conversation unless the server already supplies per-subagent events. Render the existing tool calls/events and stage statuses faithfully.

## Implementation steps

1. **Map current data to UI states**
   - Treat `historyLogs` filtered by `activeSessionId` as persisted conversation turns.
   - Treat the active `streamingChatText`, `streamingThinkingText`, and `activeToolRows` as the in-progress assistant turn.
   - Keep edit-mode prose chunks in the editor; they are not a chat response bubble.
   - Keep `log.thinking_output` separate from `log.output` in saved turns.

2. **Adopt the documented chat/message elements**
   - Add the required shadcn AI Elements using the documented component source/API.
   - Replace SimpleAssist's hand-assembled `Chat`, `ChatMessages`, `Message`, `MessageContent`, and `Bubble` conversation scaffolding with the documented conversation and message primitives.
   - Retain the existing session filtering, log ordering, telemetry expansion, context traces, and response action controls, adapting them as slots/content around the new primitives.

3. **Migrate reasoning and tool activity**
   - Replace the local `<details>/<pre>` thinking presentation with the documented reasoning element for both live thinking chunks and saved `thinking_output`.
   - Render existing structured tool rows and persisted `tool_calls` through the documented tool element, preserving current tool names/details and progress stages.
   - Continue rendering `planning`, `generating`, and post-processing statuses as status/progress UI; do not invent subagent events that are absent from SSE/log data.

4. **Integrate the composer conservatively**
   - Adopt documented prompt-input styling/structure and submit affordances where compatible.
   - Keep current `contentEditable` mention/selection chip machinery intact unless a tested equivalent supports all its behavior.
   - Preserve mode/endpoint/harness selection, context indicator, character controls, stop action, mention menu, and keyboard shortcuts.

5. **Preserve Streamdown rendering**
   - Continue using `AssistMarkdown` for final and live assistant responses, with its current streaming flag and sanitization settings.
   - Avoid introducing a second Markdown renderer in the new chat elements.

6. **Validate and refine**
   - Add/update component tests for persisted user/assistant turns, streamed assistant text, streamed and saved reasoning, tool activity, and empty/loading states.
   - Add regression coverage for composer chips, mode-specific edit streaming, and response actions if existing tests do not cover them.
   - Run targeted tests, ESLint, TypeScript, and the full Vitest suite; distinguish known baseline failures from regressions.

## Acceptance criteria

- SimpleAssist uses the documented shadcn AI Elements for its conversation, messages, reasoning, and tool activity where applicable.
- Live Chat responses and saved Chat history render through the same message structure and keep using Streamdown through `AssistMarkdown`.
- Thinking remains separate from assistant answer text, both while streaming and in history.
- Existing Edit behavior, SSE handling, session history, prompt chips, review/apply flow, actions, and cancellation remain intact.
- No user-visible or test-observable subagent messages are fabricated when the backend only provides aggregate tool/status data.
