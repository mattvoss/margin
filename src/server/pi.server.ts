/**
 * Pi harness transport.
 *
 * Embeds Pi in-process through `@earendil-works/pi-coding-agent` instead of
 * spawning the `pi` CLI and scraping its output. Margin runs unattended and
 * applies edits through its own diff review, so a single turn is:
 *
 *   createAgentSession(cwd, persistent SessionManager) -> subscribe -> prompt -> dispose
 *
 * Session continuity works the same way the OpenCode transport's does: margin
 * stores the Pi session id per Margin session and reopens that session file on
 * the next turn. Pi persists to its own directory (`~/.pi/agent/sessions/...`,
 * derived from the workspace cwd), so transcripts never land in the manuscript
 * folder the writer keeps under version control.
 *
 * Loaded lazily by harness.server.ts (dynamic import) so the SDK — a large
 * package — is only pulled in when the Pi harness is actually used.
 *
 * Only imports node modules through harness.server.ts helpers plus the SDK,
 * except for the config reads behind `registerPersistedProviders` (node:fs,
 * node:path).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ModelRuntime,
  SessionManager,
  VERSION,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { HARNESS_DESCRIPTORS, harnessToolEvent, stripAnsi } from "./harness.server";
import type { HarnessModel, HarnessQueueItem, HarnessToolEvent } from "./harness.server";
import type { HarnessRunOutcome } from "./harness.server";

const NOT_READY_HINT =
  "install the `pi` CLI and sign in with it, or configure credentials in your terminal";

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  const s = String(e ?? "");
  return s || "unknown error";
}

// ---------------------------------------------------------------------------
// Model runtime
// ---------------------------------------------------------------------------

let runtimePromise: Promise<ModelRuntime> | null = null;

/**
 * Register providers Pi persisted for its built-in extensions.
 *
 * Pi's `llama.cpp` provider is supplied by a built-in *extension*, and the CLI
 * loads those while the embedded SDK does not. A provider configured through
 * `/login llama.cpp` therefore looks missing to `getAvailableOfType`, even
 * though `pi --list-models` shows it. Restore it (and any other provider Pi
 * catalogued) from the state Pi already wrote: credentials in `auth.json` and
 * the model catalog in `models-store.json`, both under `getAgentDir()`.
 *
 * Providers the runtime already knows (pi-ai builtins, `models.json` entries)
 * are left untouched. Everything is best-effort: a missing, unreadable, or
 * malformed file must not take Pi readiness down with it.
 */
export async function registerPersistedProviders(
  runtime: ModelRuntime,
  agentDir: string = getAgentDir(),
): Promise<void> {
  try {
    const auth = await readJsonObject(join(agentDir, "auth.json"));
    const store = await readJsonObject(join(agentDir, "models-store.json"));
    if (!store) return;

    let registered = false;
    for (const [providerId, entry] of Object.entries(store)) {
      if (runtime.providerIds().has(providerId)) continue;
      const models = chatModelsFromStore(entry);
      if (models.length === 0) continue;
      try {
        const key = auth?.[providerId]?.key;
        runtime.registerProvider(providerId, {
          ...(typeof key === "string" && key ? { apiKey: key } : {}),
          models,
        });
        registered = true;
      } catch (e) {
        console.warn(`Pi provider "${providerId}" could not be restored: ${errText(e)}`);
      }
    }
    // Same follow-up the CLI's service setup does: fold the restored catalogs
    // into the availability snapshot before anything reads it.
    if (registered) await runtime.refresh({ allowNetwork: false });
  } catch (e) {
    console.warn(`Pi provider restore skipped: ${errText(e)}`);
  }
}

/** Parse a JSON object file, or null when it is missing/unreadable/not an object. */
async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Chat entries from a persisted catalog. Classifier and image entries share
 * ids with the chat model but need their own API implementations, which this
 * legacy registration does not carry.
 */
function chatModelsFromStore(entry: unknown): ProviderModelConfig[] {
  const models = (entry as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  const chat: ProviderModelConfig[] = [];
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const type = (model as { type?: unknown }).type;
    if (type !== undefined && type !== "chat") continue;
    if (typeof (model as { id?: unknown }).id !== "string") continue;
    chat.push(model as ProviderModelConfig);
  }
  return chat;
}

/**
 * Credential + model runtime over `~/.pi/agent/auth.json` and `models.json`.
 * Catalog refresh over the network is off by default, so this resolves from
 * local state alone. Providers that live in Pi's built-in extensions are then
 * restored from that same local state (see `registerPersistedProviders`).
 * Created once per process; a failure clears the cache so the next request
 * retries (the user may have just signed in).
 */
export function getPiModelRuntime(): Promise<ModelRuntime> {
  if (!runtimePromise) {
    runtimePromise = ModelRuntime.create()
      .then(async (runtime) => {
        await registerPersistedProviders(runtime);
        return runtime;
      })
      .catch((e) => {
        runtimePromise = null; // let the next attempt retry
        throw new Error(`Pi unavailable — ${NOT_READY_HINT} (${errText(e)})`);
      });
  }
  return runtimePromise;
}

/** The chat model shape `createAgentSession({ model })` accepts. */
type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/**
 * `provider/model` → Model. Provider ids never contain a slash, so the first
 * one separates them. An unparseable or unknown ref is ignored (the session
 * keeps Pi's own default) rather than failing the run — same tolerance as the
 * OpenCode transport's `parseModelRef`.
 */
function resolveModel(runtime: ModelRuntime, value: string | undefined): PiModel | undefined {
  const raw = String(value ?? "").trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;
  return runtime.getModel(raw.slice(0, slash), raw.slice(slash + 1));
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Reuse the Pi session margin recorded for this chat, or start a fresh one. A
 * mapping that no longer resolves (deleted, or from another Pi install) is
 * dropped so the conversation starts clean instead of failing the run.
 *
 * `cwd` is passed to both `findById` and `open` so the reopened session is
 * scoped to this workspace: Pi derives the session directory from the cwd.
 */
export function resolvePiSessionManager(
  cwd: string,
  resumeId?: string | null,
): SessionManager {
  if (resumeId) {
    try {
      const path = SessionManager.findById(cwd, resumeId);
      if (path) return SessionManager.open(path, undefined, cwd);
    } catch {
      // Unreadable/foreign id — fall through to a new session.
    }
  }
  return SessionManager.create(cwd);
}

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

/**
 * Per-run mapping state. Pi's tool events carry the name and args on
 * `tool_execution_start`; the matching `tool_execution_end` only repeats them,
 * so nothing needs correlating by id for display. Usage is deduped by response
 * id because both `message_end` and `turn_end` deliver the same assistant
 * message.
 */
export interface PiEventContext {
  /** Response keys already reported as usage, so `message_end`/`turn_end` can't double count. */
  seenUsage: Set<string>;
}

/** One Pi event to zero or more harness queue items. */
export function mapPiEvent(ev: AgentSessionEvent, ctx: PiEventContext): HarnessQueueItem[] {
  // The event union carries a different payload per variant, so the mapper
  // reads fields defensively instead of narrowing each case by hand.
  const e = ev as unknown as Record<string, unknown>;
  switch (e.type) {
    case "message_update": {
      const inner = e.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
      const delta = typeof inner?.delta === "string" ? inner.delta : "";
      if (!delta) return [];
      if (inner?.type === "text_delta") return [["chunk", delta]];
      if (inner?.type === "thinking_delta") return [["thinking", delta]];
      return [];
    }
    case "tool_execution_start": {
      const tool = typeof e.toolName === "string" ? e.toolName : "tool";
      const args = (e.args ?? {}) as Record<string, unknown>;
      return [["tool", toolEvent(tool, args)]];
    }
    case "tool_execution_end": {
      if (e.isError !== true) return [];
      const tool = typeof e.toolName === "string" ? e.toolName : "tool";
      return [["error_text", stripAnsi(`${tool} failed: ${toolErrorText(e.result)}`)]];
    }
    case "message_end":
    case "turn_end":
      // Both deliver the same completed assistant message; messageItems dedupes.
      return messageItems(e.message, ctx);
    default:
      return [];
  }
}

/**
 * Usage and model-level errors off a completed assistant message. `message_end`
 * and `turn_end` both carry the message, so the response key keeps the turn's
 * token count from being counted twice.
 */
function messageItems(message: unknown, ctx: PiEventContext): HarnessQueueItem[] {
  const m = message as
    | { usage?: { input?: number; output?: number }; errorMessage?: string; responseId?: string; timestamp?: number }
    | undefined;
  if (!m) return [];
  const items: HarnessQueueItem[] = [];
  if (m.errorMessage) items.push(["error_text", stripAnsi(String(m.errorMessage))]);
  const usage = m.usage;
  if (usage) {
    const key = m.responseId ?? (m.timestamp === undefined ? null : String(m.timestamp));
    if (key === null || !ctx.seenUsage.has(key)) {
      if (key !== null) ctx.seenUsage.add(key);
      items.push(["usage", { prompt_tokens: usage.input ?? 0, completion_tokens: usage.output ?? 0 }]);
    }
  }
  return items;
}

/** Name + one-line detail + raw path for a tool call (shared with OpenCode). */
function toolEvent(tool: string, input: Record<string, unknown>): HarnessToolEvent {
  return harnessToolEvent(tool, input);
}

/** Pull a readable message out of whatever shape the tool failure arrived in. */
function toolErrorText(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 200);
  if (result && typeof result === "object") {
    const r = result as { error?: unknown; message?: unknown };
    for (const v of [r.error, r.message]) {
      if (typeof v === "string" && v) return v.slice(0, 200);
    }
  }
  return "no details reported";
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * The installed SDK version, or null when it can't be determined.
 *
 * `VERSION` is read from the package's own package.json, which the bundler
 * drops when it inlines the package — that yields its `"0.0.0"` placeholder.
 * Reporting that as a version would be misleading, so it becomes "unknown"
 * (the settings row then shows just "Ready").
 */
function piVersion(): string | null {
  const v = String(VERSION ?? "");
  return v && v !== "0.0.0" ? v : null;
}

/**
 * Readiness + SDK version for `GET /api/harnesses`. Unlike OpenCode there is
 * no service to discover — the SDK runs in this process — so "ready" means the
 * runtime loaded and at least one model is usable with the stored credentials.
 */
export async function piReady(): Promise<{
  ready: boolean;
  version: string | null;
  error?: string;
}> {
  const version = piVersion();
  try {
    const models = await availablePiModels();
    if (models.length === 0) {
      return { ready: false, version, error: `no usable Pi models — ${NOT_READY_HINT}` };
    }
    return { ready: true, version };
  } catch (e) {
    // Keep the real cause (missing/broken credentials, unreadable config)
    // instead of the generic hint: getPiModelRuntime already appends it.
    return { ready: false, version, error: errText(e) };
  }
}

/**
 * Usable chat models as `provider/model`, or throws. Split out of
 * `listPiModels` so `piReady` can tell "no models configured" apart from "the
 * credentials could not be read at all".
 */
async function availablePiModels(): Promise<HarnessModel[]> {
  const runtime = await getPiModelRuntime();
  // "chat" narrows the mixed list (image/classifier models are not usable here)
  // without importing pi-ai just for the type guard.
  const available = await runtime.getAvailableOfType("chat");
  return available
    .filter((m) => m?.provider && m?.id)
    .map((m) => ({
      id: `${m.provider}/${m.id}`,
      name: m.name || `${m.provider}/${m.id}`,
    }));
}

/**
 * Live `provider/model` list for the Settings dropdown, filtered to models the
 * stored credentials can actually use. Pi's catalog is global (`~/.pi/agent`),
 * so — unlike OpenCode — this needs no workspace directory.
 *
 * Every failure degrades to manual entry so the settings dialog still lets the
 * user type a model name by hand.
 */
export async function listPiModels(): Promise<{
  models: HarnessModel[];
  manual: boolean;
}> {
  try {
    const models = await availablePiModels();
    return { models, manual: models.length === 0 };
  } catch {
    return { models: [], manual: true };
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface PiRunRequest {
  prompt: string;
  cwd: string;
  mode: string;
  resumeId?: string | null;
  model?: string;
  signal: AbortSignal;
  /** Synchronous by contract: dispatch enqueues straight into its SSE stream. */
  onItems: (items: HarnessQueueItem[]) => void;
}

/**
 * Run one turn. Returns `code: 1` only for transport/setup failures; a
 * model-level failure arrives as `error_text` and keeps the session resumable,
 * matching how the CLI and OpenCode paths treat a failed run.
 *
 * `prompt()` resolves when the run finishes, including automatic retries, so
 * there is no terminator event to wait for and no separate subscription pump:
 * the listener below is synchronous and only enqueues.
 */
export async function runPiHarness(req: PiRunRequest): Promise<HarnessRunOutcome> {
  let session: AgentSession | null = null;
  let sessionId: string | null = null;
  try {
    const runtime = await getPiModelRuntime();
    const sessionManager = resolvePiSessionManager(req.cwd, req.resumeId);
    sessionId = sessionManager.getSessionId();

    // Chat must not touch the manuscript; edit gets the coding set. Both are
    // declared in the descriptor so the tool policy stays with the registry.
    const tools = HARNESS_DESCRIPTORS.pi?.mode_tools?.[req.mode];
    const model = resolveModel(runtime, req.model);

    const created = await createAgentSession({
      cwd: req.cwd,
      sessionManager,
      modelRuntime: runtime,
      ...(model ? { model } : {}),
      ...(tools ? { tools } : {}),
    });
    session = created.session;
    if (created.modelFallbackMessage) {
      console.warn(`Pi model fallback: ${created.modelFallbackMessage}`);
    }

    const ctx: PiEventContext = { seenUsage: new Set() };
    const unsubscribe = session.subscribe((ev) => {
      const items = mapPiEvent(ev, ctx);
      if (items.length) req.onItems(items);
    });

    const onAbort = () => {
      // abort() stops the active run and waits for idle; dispose() in the
      // finally block is the backstop if this never settles.
      void session?.abort().catch((e) => {
        console.warn(`Pi abort failed: ${errText(e)}`);
      });
    };
    req.signal.addEventListener("abort", onAbort, { once: true });
    if (req.signal.aborted) onAbort();

    try {
      await session.prompt(req.prompt);
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }

    // A model-level failure already arrived as error_text and the session
    // stays resumable, so this is a successful transport run.
    return { code: 0, sessionId };
  } catch (e) {
    return { code: 1, sessionId, error: errText(e) };
  } finally {
    // Tears down listeners and aborts anything still in flight. The session
    // file is already written, so the next turn reopens it.
    try {
      session?.dispose();
    } catch (e) {
      console.warn(`Pi dispose failed: ${errText(e)}`);
    }
  }
}