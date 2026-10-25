# Post-processing

Post-processing runs a small pipeline of rewrites **after** the Writer or a harness produces text, but **before** the result reaches you. It is off by default.

Open **Settings > Post-processing** to configure it.

## How it works

A preset contains an ordered list of passes. Each pass:

- receives the previous pass's text plus the upstream system instructions and your original request; these constraints take precedence over a pass's generic editing goal
- can use its own endpoint, prompt, temperature, and token limit
- can optionally receive character context, recent scene turns, pinned reference files, or a document window
- is independent: disabling or reordering one pass never rewrites another pass's prompt

Passes are instructed to preserve the established voice, meaning, events, dialogue intent, POV, tense, and level of detail, and to make only the smallest safe improvement. If a pass fails or returns empty output, Margin keeps the previous text and continues. A failed pass never discards the generation.

## Starter passes

Four passes ship disabled:

| Pass | What it does |
| --- | --- |
| **Grounding** | Makes prose feel rooted in the story's world, rules, tone, and setting. Adds a short beat when action or time jumps abruptly. |
| **Character Behavior Validator** | Fixes dialogue and actions that contradict a character's established voice. Does not polish prose. |
| **Prose Rhythm** | Improves sentence variety, showing over telling, and filler without changing events or dialogue. |
| **Repetition Hammer** | Removes repeated words, phrases, and dialogue beats without adding content. |

Toggle a pass on to include it. Use the arrow buttons to reorder passes; the list runs top to bottom.

## Where it applies

- **Edit** — panel edits and inline Rewrite/insert results from an endpoint. On by default.
- **Chat** — assistant replies. Off by default so questions are not rewritten.
- **Harness** — only the paragraph hunks the harness changed in the **active file**. Other files are not post-processed in this version. On by default.

Agent harnesses are never used to run passes. Every pass calls the endpoint configured for it, falling back to the active endpoint.

## Review and cost

- **Review before applying** keeps the normal endpoint accept/reject review. Turn it off to insert and save the final text immediately. Harness runs always keep their existing three-way merge review.
- **Minimum characters** skips the pipeline for short outputs (default `60`). Harness runs apply this per changed hunk.
- A harness run processes at most **6 changed hunks** and **20,000 characters** per run. Skipped hunks are reported in the result.
- The settings screen shows the worst-case extra call count. Each enabled pass is one extra call per generation, and a harness run can make up to one call per pass per changed hunk.

## Context options

Each pass can opt into:

- **Characters** — the active cast description used by the Writer.
- **Scene history** — the last N turns from this session, capped and trimmed.
- **Pinned refs** — files pinned in **Settings > Context**.
- **Document window** — the paragraph before, the target text, and the paragraph after. Harness passes use the changed hunk as the target.

Prompt text is wrapped as `<text_to_transform>`. The pass should return only the rewritten text; Margin strips a single wrapping Markdown code fence if one appears.

## Logs

Every generation records the post-processing summary in the Assist telemetry panel: which passes ran, their status, model, and token usage. Endpoint runs keep the raw pre-post-processing output alongside the final output in `outputs/ai_logs/`; harness runs record per-hunk pass snapshots instead of a whole-file duplicate.
