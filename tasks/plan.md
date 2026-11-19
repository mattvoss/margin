# Implementation Plan: Make Agent Memory Visible and Verifiable

## Overview

Give end users a trustworthy way to understand whether workspace memory is configured, enabled, and actually participating in chats, while allowing them to inspect and archive the memories stored for the active workspace. The feature will use the existing DuckDB memory store and endpoint settings, preserve the current opt-in behavior, and avoid exposing embedding credentials or silently presenting recalled text as authoritative.

## User experience

### Memory panel

Add a **Memory** section to Settings (preferably beside the existing Context section, or as a dedicated tab if the panel becomes too large) containing:

- A status summary with distinct states:
  - **Off** — the server memory flag is disabled.
  - **Needs embedding model** — memory is enabled in principle, but the active endpoint has no embedding model or usable URL.
  - **Ready** — configuration is valid and the store is reachable.
  - **Unavailable** — the store or embedding health check failed; chat must continue normally.
- Separate labels for **Recall** and **Automatic saving**, since they are independent opt-in flags.
- The active embedding model name, without displaying the API key.
- Count of active memories and optionally archived memories.
- Last successful save/recall timestamps when available.
- A refresh action and an explanation that memory is workspace-scoped.

### Memory list

Show the active workspace's memories in a bounded, searchable/filterable list:

- Kind (`fact`, `preference`, `skill`, `project context`, or `instruction`).
- Memory content.
- Created/updated time and access count.
- Archive action, with confirmation or undo affordance.
- Optional archived-memory view.
- Empty states that explain whether there are no memories yet or memory is not configured.

Do not show embeddings, API keys, database paths, or raw internal prompt wrappers.

### Chat activity

Add compact, non-intrusive activity events to the existing assist activity/notice UI:

- `Memory recalled: N relevant memories` when recall returns results.
- `Memory checked: no relevant memories` when memory is ready but no result passes the threshold.
- `Memory saved: N new memories` after automatic extraction saves candidates.
- `Memory unavailable` only when a memory operation fails; do not turn a best-effort memory failure into a chat failure.

The event should be expandable to show the relevant memory IDs or a short preview only if that is consistent with the existing activity UI. The full source of truth remains the Memory panel.

## Architecture decisions

- Keep memory availability derived from the active Settings endpoint and existing server flags; do not reintroduce embedding environment variables.
- Add a server status/read model rather than making the client infer readiness from the raw settings object.
- Keep workspace scoping enforced server-side using `requestWorkspaceDir`; never accept a workspace key from the UI as authority.
- Keep archive semantics; the UI should not hard-delete memories.
- Treat memory content as user-controlled/untrusted text. Render it as text, escape it through normal React rendering, and label it as remembered context rather than instructions.
- Make health checks explicit and bounded. A status load may verify DuckDB access, but should not make an embedding request on every Settings render. Provide an explicit “Test memory” action for an embedding round trip.
- Preserve fail-safe chat behavior. Recall/save errors produce status events and logs, not failed assistant requests.
- Avoid leaking secrets in status responses or telemetry.

## Proposed API contract

### `GET /api/memory/status`

Returns a request-scoped, workspace-scoped status object such as:

```json
{
  "state": "ready",
  "enabled": true,
  "recallEnabled": true,
  "extractionEnabled": true,
  "embeddingConfigured": true,
  "embeddingModel": "text-embedding-3-small",
  "activeCount": 12,
  "archivedCount": 2,
  "lastSavedAt": "2026-11-19T20:00:00.000Z",
  "lastRecalledAt": "2026-11-19T20:01:00.000Z",
  "workspaceScoped": true
}
```

The exact state should be derived server-side and should distinguish disabled, unconfigured, ready, and unavailable conditions.

### `POST /api/memory/test`

Optional explicit action from the Memory panel. It verifies the configured embedding endpoint with a harmless fixed test string and verifies that the DuckDB store can be opened. It returns success/failure without returning credentials or the test vector.

### Existing memory endpoints

Keep `GET /api/memory` as the list source and `DELETE /api/memory/:id` as archive. Extend the list response only where needed for display metadata; do not expose embeddings.

### Assist SSE events

Add structured events, for example:

```json
{ "status": "memory_recall", "state": "used", "count": 2 }
{ "status": "memory_recall", "state": "none", "count": 0 }
{ "status": "memory_status", "state": "unavailable", "detail": "..." }
{ "status": "memory_saved", "count": 1 }
```

Keep error details sanitized. The client should tolerate these events when talking to an older server.

## Task list

### Phase 1: Server observability contract

1. Add a memory status summary function and `GET /api/memory/status`.
2. Add focused tests for all status states, workspace scoping, counts, and secret redaction.
3. Add explicit embedding/store test behavior behind `POST /api/memory/test`, with timeout/error handling.
4. Emit recall and save result events from the assist stream without changing normal chat failure behavior.

### Checkpoint: Server contract

- Focused memory and route tests pass.
- Status responses never contain API keys, vectors, or database paths.
- Chat still completes when recall, extraction, or the status store fails.

### Phase 2: Memory management UI

5. Add the Memory settings section and load `/api/memory/status` plus `/api/memory` for the active workspace.
6. Render status, configuration guidance, counts, timestamps, loading/error states, and explicit test action.
7. Render memory rows with kind, content, metadata, filtering/search, archived view, and archive action.
8. Refresh status/list after archiving and after workspace changes; avoid showing stale memories from another workspace.

### Checkpoint: User can inspect memory

- A user can tell whether memory is off, unconfigured, ready, or unavailable.
- A user can see the active workspace's stored memories and archive one.
- Empty and failure states explain what action is needed.

### Phase 3: Chat activity feedback

9. Handle memory SSE events in `SimpleAssist` and display concise activity feedback.
10. Add tests for recalled, empty, saved, and unavailable event rendering.
11. Refresh the Memory panel's list/status after a completed chat when save events occur, where the panel is open.

### Checkpoint: End-to-end confidence

- Configure an embedding model, send a chat that recalls a known memory, and see a recall activity event.
- Enable extraction, send a chat that produces a candidate, and see the saved count and the new row in the panel.
- Disable memory or remove the embedding model and see a clear disabled/unconfigured state with no memory context injected.
- Force an embedding/store failure and confirm chat still succeeds while the UI reports unavailable memory.

## Verification

- Focused unit tests for status derivation, API response redaction, event handling, and memory list rendering.
- Existing memory/extraction test suite.
- Production build with `npm run build`.
- Manual browser verification of Settings → Memory, workspace switching, archive, test action, and chat activity.
- Run a final code review for workspace isolation, secret exposure, accessibility, and fail-safe behavior.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Status says “ready” but embedding requests fail later | High trust issue | Keep an explicit test action and report runtime failures as unavailable; do not claim a successful recall unless the operation completed. |
| Memory panel displays another workspace's data | High privacy issue | Derive workspace only from the server request context and refresh on workspace changes. |
| Automatic extraction completes after the SSE closes | Medium feedback gap | Define whether extraction status is awaited with a short timeout or persisted as last-save metadata; test the chosen behavior. |
| Raw memory content contains hostile instructions | Medium safety issue | Render as inert text, preserve untrusted labeling, and never execute content in the client. |
| Frequent polling adds load | Low/medium | Load on panel open, refresh on explicit action and relevant events, and avoid embedding probes during ordinary rendering. |

## Open questions

- Should the Memory panel be a new top-level Settings tab or part of the existing Context tab?
- Should the “Test memory” action make a live embedding request by default, or only test DuckDB unless the user explicitly opts into a provider call?
- Should recalled memory previews be shown in chat activity, or only counts plus a link to the Memory panel to minimize prompt-content leakage?
- Should automatic extraction be awaited briefly to guarantee a “saved” event, or remain fully asynchronous with the panel reading persisted last-save metadata?
