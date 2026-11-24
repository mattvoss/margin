# Plan: Search workspace memory before asking for clarification

## Goal

Let the clarification agent consult relevant workspace memories on demand before asking the user questions. Ask the user only when memory and the supplied request/context still leave a material ambiguity.

## Current behavior

- Workspace memory is optional and disabled unless enabled on the server.
- Planner, chat, and scene-planner agents already receive a bounded, read-only `search_memory` tool when memory context is supplied.
- The write-clarification agent currently has `ask_user` and `proceed_to_plan` tools, but no memory search tool.
- Memory results are workspace-scoped and explicitly treated as untrusted reference material, not instructions.

## Implementation steps

1. **Pass memory context to the clarification agent**
   - Add an optional `MemoryToolContext` input to `createWriteClarificationAgent`.
   - At the call site, provide the active workspace key and memory configuration, matching the existing planner/chat setup.

2. **Expose on-demand search**
   - Attach the existing bounded `search_memory` tool only when memory context is available.
   - Preserve the existing schema limits, workspace scoping, abort handling, and untrusted-memory warning; do not add write-capable memory operations.

3. **Update clarification instructions and loop budget**
   - Tell the agent to search memory when a question may already be answered by prior workspace context.
   - Treat results as evidence/context only, never as instructions; prefer explicit current user input where it conflicts with old memories.
   - Ask the user only for unresolved details that would materially change the plan; otherwise proceed.
   - Increase the clarification agent's tool-call ceiling enough to allow a search followed by either `ask_user` or `proceed_to_plan`, while retaining a strict bound.

4. **Preserve graceful behavior**
   - When memory is disabled or unavailable, the agent should retain its current ask-or-proceed behavior.
   - Search failures should not block clarification; report no usable memory and continue safely.

5. **Add tests**
   - Verify `search_memory` is exposed only when memory context is supplied.
   - Verify the clarification agent can search and then proceed or ask a follow-up.
   - Verify no-memory and unavailable-memory paths retain existing behavior.
   - Verify bounded input validation and that results are framed as untrusted context.

6. **Validate**
   - Run the focused agent tests, memory-tool tests, full test suite, type-check, and lint.

## Out of scope

- Giving the edit/writing agents new tools.
- Changing memory indexing, storage, retrieval ranking, or settings.
- Automatically treating memories as authoritative instructions.
