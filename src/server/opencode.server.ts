/**
 * OpenCode harness transport.
 *
 * Talks to the user's local OpenCode service over the typed V2 TypeScript
 * client (`@opencode/client`) instead of spawning `opencode run --format json`
 * and scraping JSON lines. The service is the one the OpenCode CLI registers
 * (`opencode serve --service`); we discover it, or start it from the installed
 * CLI when nothing is registered yet.
 *
 * Loaded lazily by harness.server.ts (dynamic import) so the client is only
 * pulled in when the OpenCode harness is actually used.
 *
 * Only imports node modules through harness.server.ts helpers plus the client.
 */

import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { OpenCodeClient, OpenCodeEvent, SessionInfo } from "@opencode/client";
import {
  HARNESS_DESCRIPTORS,
  harnessToolEvent,
  normalizedEnv,
  stripAnsi,
} from "./harness.server";
import type { HarnessModel, HarnessQueueItem, HarnessToolEvent } from "./harness.server";
import type { HarnessRunOutcome } from "./harness.server";

/** Only V2 servers speak this contract; V1 (the old `@opencode-ai/sdk`) does not. */
const REQUIRED_MAJOR = "2";

const NOT_READY_HINT =
  "install the `opencode` CLI (v2) and sign in, or run `opencode serve`";

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  const s = String(e ?? "");
  return s || "unknown error";
}

// ---------------------------------------------------------------------------
// Client lifecycle
// ---------------------------------------------------------------------------

let clientPromise: Promise<OpenCodeClient> | null = null;

/** Authenticated client for the local OpenCode service, created once per process. */
export function getOpencodeClient(): Promise<OpenCodeClient> {
  if (!clientPromise) {
    clientPromise = connect().catch((e) => {
      clientPromise = null; // let the next attempt retry
      throw new Error(`OpenCode service unavailable — ${NOT_READY_HINT} (${errText(e)})`);
    });
  }
  return clientPromise;
}

async function connect(): Promise<OpenCodeClient> {
  // discover() never spawns; ensure() starts `opencode serve --service` when
  // nothing compatible is registered. The version predicate makes a stale V1
  // registration get replaced rather than used.
  const endpoint = (await Service.discover({ version: isCompatible })) ?? (await Service.ensure({
    version: isCompatible,
    command: ["opencode", "serve", "--service"],
    env: { PATH: normalizedEnv().PATH ?? "" },
  }));
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const info = await client.server.info();
  const version = String(info?.version ?? "");
  if (version && version !== "unknown" && !isCompatible(version)) {
    throw new Error(
      `OpenCode service v${version} is not supported (need v${REQUIRED_MAJOR}.x) — update the \`opencode\` CLI`,
    );
  }
  return client;
}

function isCompatible(version: string): boolean {
  return version === "unknown" || version.startsWith(`${REQUIRED_MAJOR}.`);
}

/** Readiness + version for `GET /api/harnesses`. */
export async function opencodeReady(): Promise<{
  ready: boolean;
  version: string | null;
  error?: string;
}> {
  try {
    const client = await getOpencodeClient();
    const info = await client.server.info();
    const version = String(info?.version ?? "");
    return { ready: true, version: version && version !== "unknown" ? version : null };
  } catch (e) {
    return { ready: false, version: null, error: errText(e) };
  }
}

/** Live `provider/model` list for the Settings dropdown. */
export async function listOpencodeModels(directory: string): Promise<{
  models: HarnessModel[];
  manual: boolean;
}> {
  try {
    const client = await getOpencodeClient();
    const { data } = await client.model.list({ location: { directory } });
    const models: HarnessModel[] = (data ?? [])
      .filter((m) => m?.enabled !== false)
      .map((m) => ({ id: `${m.providerID}/${m.modelID}`, name: m.name || `${m.providerID}/${m.modelID}` }));
    // manual only when the service gave us nothing — same contract as the CLI
    // harnesses, which fall back to a free-text box on an empty listing.
    return { models, manual: models.length === 0 };
  } catch {
    return { models: [], manual: true };
  }
}

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

/**
 * Per-run mapping state. Tool names are not carried on the tool events
 * themselves — they arrive on `session.tool.input.started` and are correlated
 * by call id.
 */
export interface OpencodeEventContext {
  sessionID: string;
  toolNames: Map<string, string>;
}

/** Narrows an event to our session; every session-scoped event carries the id. */
function forSession(ev: OpenCodeEvent, sessionID: string): boolean {
  const data = (ev as { data?: { sessionID?: unknown } }).data;
  return data?.sessionID === sessionID;
}

/**
 * Which event ends the turn, if any. `session.execution.failed` is a
 * model/provider failure, not a transport failure: it still ends the run but
 * the text already streamed is kept and the session stays resumable.
 */
export function opencodeTerminal(
  ev: OpenCodeEvent,
  sessionID: string,
): "idle" | "failed" | "interrupted" | null {
  const type = (ev as { type?: string }).type;
  if (type !== "session.idle" && !type?.startsWith("session.execution.")) return null;
  if (!forSession(ev, sessionID)) return null;
  if (type === "session.idle") return "idle";
  if (type === "session.execution.succeeded") return "idle";
  if (type === "session.execution.failed") return "failed";
  if (type === "session.execution.interrupted") return "interrupted";
  return null;
}

/** One V2 event to zero or more harness queue items. */
export function mapOpencodeEvent(ev: OpenCodeEvent, ctx: OpencodeEventContext): HarnessQueueItem[] {
  const type = (ev as { type?: string }).type ?? "";
  const data = (ev as { data?: Record<string, unknown> }).data;
  if (!type.startsWith("session.") && type !== "permission.asked") return [];
  if (!data) return [];
  if (type !== "permission.asked" && !forSession(ev, ctx.sessionID)) return [];

  const id = typeof data.id === "string" ? data.id : "";

  switch (type) {
    case "session.text.delta": {
      const delta = typeof data.delta === "string" ? data.delta : "";
      return delta ? [["chunk", delta]] : [];
    }
    case "session.reasoning.delta": {
      const delta = typeof data.delta === "string" ? data.delta : "";
      return delta ? [["thinking", delta]] : [];
    }
    case "session.tool.input.started": {
      // Remember the name; the tool events that follow only carry the call id.
      if (id && typeof data.name === "string" && data.name) ctx.toolNames.set(id, data.name);
      return [];
    }
    case "session.tool.called": {
      const input = (data.input ?? {}) as Record<string, unknown>;
      const tool = ctx.toolNames.get(id) ?? "tool";
      return [["tool", toolEvent(tool, input)]];
    }
    case "session.tool.failed": {
      const tool = ctx.toolNames.get(id) ?? "tool";
      const message = errText((data.error as { message?: unknown } | undefined)?.message);
      return [["error_text", stripAnsi(`${tool} failed: ${message}`)]];
    }
    case "session.usage.updated": {
      const tokens = (data.tokens ?? {}) as { input?: number; output?: number };
      return [["usage", { prompt_tokens: tokens.input ?? 0, completion_tokens: tokens.output ?? 0 }]];
    }
    case "session.execution.failed": {
      const message = errText((data.error as { message?: unknown } | undefined)?.message);
      return message ? [["error_text", stripAnsi(message)]] : [];
    }
    default:
      return [];
  }
}

/** Same shape as the CLI parsers' `queueTool`: name + one-line detail + raw path. */
function toolEvent(tool: string, input: Record<string, unknown>): HarnessToolEvent {
  return harnessToolEvent(tool, input);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface OpencodeRunRequest {
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
 * `provider/model` → ModelRef. Provider ids never contain a slash, so the first
 * one separates them; anything unparseable is ignored (the session keeps
 * OpenCode's own default).
 */
function parseModelRef(value: string | undefined): { providerID: string; id: string } | null {
  const raw = String(value ?? "").trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  return { providerID: raw.slice(0, slash), id: raw.slice(slash + 1) };
}

/**
 * Reuse the session margin recorded for this chat, or start a fresh one. A
 * mapping that no longer resolves (deleted, or from another OpenCode install)
 * is dropped so the conversation starts clean instead of failing the run.
 */
async function resolveSession(
  oc: OpenCodeClient,
  req: OpencodeRunRequest,
  location: { directory: string },
): Promise<{ sessionID: string; info: SessionInfo }> {
  const resumeId = req.resumeId;
  if (resumeId) {
    try {
      return { sessionID: resumeId, info: await oc.session.get({ sessionID: resumeId }) };
    } catch {
      // fall through to a new session
    }
  }
  const basename = req.cwd.split("/").filter(Boolean).pop() ?? "workspace";
  const info = await oc.session.create({
    location,
    title: `Margin · ${basename} · ${req.mode}`,
    // Replaces the old `--auto` flag: margin runs unattended and applies edits
    // through its own diff review.
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  });
  return { sessionID: info.id, info };
}

/**
 * Run one turn. Returns `code: 1` only for transport/setup failures; a
 * model-level failure arrives as `error_text` and keeps the session resumable,
 * matching how the CLI path treats nonzero exit as the only fatal case.
 */
export async function runOpencodeHarness(
  req: OpencodeRunRequest,
  client?: OpenCodeClient,
): Promise<HarnessRunOutcome> {
  const oc = client ?? (await getOpencodeClient());
  const location = { directory: req.cwd };

  // --- session: reuse the mapped one when it still exists, else create ---
  const { sessionID, info } = await resolveSession(oc, req, location);

  // --- agent + model live on the session, not on the prompt ---
  const agent = HARNESS_DESCRIPTORS.opencode?.mode_agents?.[req.mode];
  if (agent && info.agent !== agent) {
    await oc.session.switchAgent({ sessionID, agent });
  }
  const model = parseModelRef(req.model);
  if (model && (info.model?.providerID !== model.providerID || info.model?.id !== model.id)) {
    await oc.session.switchModel({ sessionID, model });
  }

  // --- event pump ---
  // The client shares one lazy connection per client and the server waits for
  // each subscriber to accept an event, so the loop below must never await:
  // it only enqueues, and the drain does the work.
  type Pending = { kind: "items"; items: HarnessQueueItem[] } | { kind: "permission"; requestID: string };
  const ctx: OpencodeEventContext = { sessionID, toolNames: new Map() };
  const pending: Pending[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let terminal: "idle" | "failed" | "interrupted" | null = null;

  const signalWork = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const waitWork = () =>
    new Promise<void>((res) => {
      wake = res;
    });

  const iterator = oc.event.subscribe()[Symbol.asyncIterator]();
  const stopPump = () => {
    finished = true;
    signalWork();
    void iterator.return?.(undefined as never);
  };

  const pump = (async () => {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const ev = next.value as OpenCodeEvent;
        const type = (ev as { type?: string }).type ?? "";
        if (type === "permission.asked" && forSession(ev, sessionID)) {
          const requestID = String((ev as { data?: { id?: unknown } }).data?.id ?? "");
          if (requestID) pending.push({ kind: "permission", requestID });
        } else {
          // Map before breaking on the terminator: `session.execution.failed`
          // carries the error text the user needs to see.
          const items = mapOpencodeEvent(ev, ctx);
          if (items.length) pending.push({ kind: "items", items });
        }
        const done = opencodeTerminal(ev, sessionID);
        if (done) {
          terminal = done;
          break;
        }
        signalWork();
      }
    } catch (e) {
      if (!terminal) console.warn(`OpenCode event stream ended: ${errText(e)}`);
    } finally {
      finished = true;
      signalWork();
    }
  })();

  const interrupt = () => {
    void oc.session.interrupt({ sessionID }).catch((e) => {
      console.warn(`OpenCode interrupt failed: ${errText(e)}`);
    });
  };
  const onAbort = () => {
    interrupt();
  };
  req.signal.addEventListener("abort", onAbort, { once: true });
  if (req.signal.aborted) onAbort();

  // --- prompt ---
  let promptError: unknown = null;
  const promptTask = oc.session
    .prompt({ sessionID, text: req.prompt, delivery: "steer" })
    .catch((e) => {
      promptError = e;
      // The session never started a turn, so no terminal event is coming.
      interrupt();
      stopPump();
    });

  // --- drain: apply queue items and answer permission asks ---
  let applyError: unknown = null;
  try {
    for (;;) {
      if (pending.length === 0 && !finished) await waitWork();
      while (pending.length > 0) {
        const entry = pending.shift() as Pending;
        if (entry.kind === "items") {
          req.onItems(entry.items);
        } else {
          // Allow-all is set on the session; this is the belt-and-braces path
          // for asks raised by plugins or a stricter project config.
          await oc.permission
            .reply({ sessionID, requestID: entry.requestID, decision: "once" })
            .catch((e) => console.warn(`OpenCode permission auto-reply failed: ${errText(e)}`));
        }
      }
      if (finished && pending.length === 0) break;
    }
  } catch (e) {
    applyError = e;
  }

  req.signal.removeEventListener("abort", onAbort);
  stopPump();
  await promptTask;
  void pump;

  const failed = promptError ?? applyError;
  if (failed) {
    return { code: 1, sessionId: sessionID, error: errText(failed) };
  }
  if (terminal && terminal !== "idle") {
    console.warn(`OpenCode turn ended as ${terminal} for session ${sessionID}`);
  }
  // A model-level failure already arrived as error_text and the session stays
  // resumable, so it is a successful transport run.
  return { code: 0, sessionId: sessionID };
}
