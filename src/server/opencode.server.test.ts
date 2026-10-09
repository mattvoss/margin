// @vitest-environment node
//
// Fixtures below are trimmed from a real capture against a live OpenCode v2
// service (recorded with `client.event.subscribe()` during a real tool-using
// turn), so the mapper is tested against the shapes the server actually sends.

import { describe, expect, it, vi } from "vitest";
import {
  listOpencodeModels,
  mapOpencodeEvent,
  opencodeTerminal,
  runOpencodeHarness,
} from "./opencode.server";
import type { OpencodeEventContext } from "./opencode.server";
import type { OpenCodeEvent } from "@opencode/client";

const SID = "ses_ef09542e8ffeX1JzTmoH4pjBt0";

const textDelta = {
  id: "evt_10f6ad9db0014cYbOU6RZyjyQp",
  created: 1791260023259,
  type: "session.text.delta",
  location: { directory: "/tmp/opencode/spike/ws" },
  data: {
    sessionID: SID,
    assistantMessageID: "msg_10f6ad10f001FqB3sfqNiTQccm",
    ordinal: 0,
    delta: "Wrote `hello` to `cap.txt`.",
  },
} as unknown as OpenCodeEvent;

const reasoningDelta = {
  id: "evt_10f6ac35f001lHSKYVedhCGiNW",
  created: 1791260017503,
  type: "session.reasoning.delta",
  data: {
    sessionID: SID,
    assistantMessageID: "msg_10f6abd3c001mwJckmBDeleoMp",
    ordinal: 0,
    delta: 'The user wants me to write "hello" into a file named cap.',
  },
} as unknown as OpenCodeEvent;

const toolInputStarted = {
  id: "evt_10f6ac7be001g4gXSgPVuL4tVJ",
  created: 1791260018622,
  type: "session.tool.input.started",
  data: {
    sessionID: SID,
    assistantMessageID: "msg_10f6abd3c001mwJckmBDeleoMp",
    id: "functions.write:0",
    name: "write",
  },
  durable: { aggregateID: SID, seq: 7, version: 1 },
} as unknown as OpenCodeEvent;

const toolCalled = {
  id: "evt_10f6ac7c30013mowPJ1Ocklzzp",
  created: 1791260018627,
  type: "session.tool.called",
  data: {
    sessionID: SID,
    assistantMessageID: "msg_10f6abd3c001mwJckmBDeleoMp",
    id: "functions.write:0",
    input: { content: "hello", path: "/tmp/opencode/spike/ws/cap.txt" },
    executed: false,
  },
} as unknown as OpenCodeEvent;

const toolFailed = {
  id: "evt_1",
  created: 1791260018627,
  type: "session.tool.failed",
  data: {
    sessionID: SID,
    id: "functions.write:0",
    error: { type: "ToolError", message: "EACCES: permission denied", status: 500 },
    executed: false,
  },
} as unknown as OpenCodeEvent;

const usageUpdated = {
  id: "evt_10f6ac7cc001k62c3rvqV45CVU",
  created: 1791260018636,
  type: "session.usage.updated",
  data: {
    sessionID: SID,
    cost: 0,
    tokens: { input: 7485, output: 98, reasoning: 0, cache: { read: 0, write: 0 } },
  },
} as unknown as OpenCodeEvent;

const executionSucceeded = {
  id: "evt_10f6ad9e00028zpHjp1neQscDv",
  created: 1791260023264,
  type: "session.execution.succeeded",
  data: { sessionID: SID },
} as unknown as OpenCodeEvent;

const executionFailed = {
  id: "evt_2",
  created: 1791260023264,
  type: "session.execution.failed",
  data: { sessionID: SID, error: { type: "ProviderError", message: "rate limited", status: 429 } },
} as unknown as OpenCodeEvent;

const executionInterrupted = {
  id: "evt_3",
  created: 1791260023264,
  type: "session.execution.interrupted",
  data: { sessionID: SID, reason: "user" },
} as unknown as OpenCodeEvent;

const permissionAsked = {
  id: "evt_4",
  created: 1791260023264,
  type: "permission.asked",
  data: { id: "per_1", sessionID: SID, action: "edit", resources: ["/ws/cap.txt"] },
} as unknown as OpenCodeEvent;

const otherSessionEvent = {
  ...textDelta,
  data: { ...(textDelta as unknown as { data: object }).data, sessionID: "ses_other" },
} as unknown as OpenCodeEvent;

const serverConnected = { id: "evt_5", created: 1, type: "server.connected" } as unknown as OpenCodeEvent;

function ctx(): OpencodeEventContext {
  return { sessionID: SID, toolNames: new Map() };
}

// --- mapper ---------------------------------------------------------------

describe("mapOpencodeEvent", () => {
  it("maps text deltas to chunks and reasoning deltas to thinking", () => {
    expect(mapOpencodeEvent(textDelta, ctx())).toEqual([["chunk", "Wrote `hello` to `cap.txt`."]]);
    expect(mapOpencodeEvent(reasoningDelta, ctx())).toEqual([
      ["thinking", 'The user wants me to write "hello" into a file named cap.'],
    ]);
  });

  it("drops empty deltas", () => {
    const empty = {
      ...textDelta,
      data: { ...(textDelta as unknown as { data: object }).data, delta: "" },
    } as unknown as OpenCodeEvent;
    expect(mapOpencodeEvent(empty, ctx())).toEqual([]);
  });

  it("resolves the tool name from input.started via the call id", () => {
    const c = ctx();
    expect(mapOpencodeEvent(toolInputStarted, c)).toEqual([]);
    expect(c.toolNames.get("functions.write:0")).toBe("write");
    expect(mapOpencodeEvent(toolCalled, c)).toEqual([
      ["tool", { tool: "write", detail: "cap.txt", path: "/tmp/opencode/spike/ws/cap.txt" }],
    ]);
  });

  it("falls back to a generic tool name when the name event was missed", () => {
    expect(mapOpencodeEvent(toolCalled, ctx())).toEqual([
      ["tool", { tool: "tool", detail: "cap.txt", path: "/tmp/opencode/spike/ws/cap.txt" }],
    ]);
  });

  it("maps tool failures to error_text with the tool name", () => {
    const c = ctx();
    mapOpencodeEvent(toolInputStarted, c);
    expect(mapOpencodeEvent(toolFailed, c)).toEqual([
      ["error_text", "write failed: EACCES: permission denied"],
    ]);
  });

  it("maps usage to prompt/completion tokens", () => {
    expect(mapOpencodeEvent(usageUpdated, ctx())).toEqual([
      ["usage", { prompt_tokens: 7485, completion_tokens: 98 }],
    ]);
  });

  it("maps execution failures to error_text", () => {
    expect(mapOpencodeEvent(executionFailed, ctx())).toEqual([["error_text", "rate limited"]]);
  });

  it("ignores events from other sessions", () => {
    expect(mapOpencodeEvent(otherSessionEvent, ctx())).toEqual([]);
  });

  it("ignores non-session events and terminal events", () => {
    expect(mapOpencodeEvent(serverConnected, ctx())).toEqual([]);
    expect(mapOpencodeEvent(executionSucceeded, ctx())).toEqual([]);
  });

  it("ignores permission asks (the run loop answers them)", () => {
    expect(mapOpencodeEvent(permissionAsked, ctx())).toEqual([]);
  });
});

describe("opencodeTerminal", () => {
  it("ends the turn on execution succeeded", () => {
    expect(opencodeTerminal(executionSucceeded, SID)).toBe("idle");
  });

  it("reports failed and interrupted distinctly", () => {
    expect(opencodeTerminal(executionFailed, SID)).toBe("failed");
    expect(opencodeTerminal(executionInterrupted, SID)).toBe("interrupted");
  });

  it("treats session.idle as a terminator", () => {
    const idle = { type: "session.idle", data: { sessionID: SID } } as unknown as OpenCodeEvent;
    expect(opencodeTerminal(idle, SID)).toBe("idle");
  });

  it("does not end the turn mid-execution", () => {
    const started = { type: "session.execution.started", data: { sessionID: SID } } as unknown as OpenCodeEvent;
    expect(opencodeTerminal(started, SID)).toBeNull();
  });

  it("ignores terminators for other sessions", () => {
    expect(opencodeTerminal(executionSucceeded, "ses_other")).toBeNull();
  });

  it("ignores ordinary step events", () => {
    const step = { type: "session.step.ended", data: { sessionID: SID } } as unknown as OpenCodeEvent;
    expect(opencodeTerminal(step, SID)).toBeNull();
  });
});

// --- run ------------------------------------------------------------------

interface FakeOptions {
  events?: OpenCodeEvent[];
  getThrows?: boolean;
  promptThrows?: boolean;
  /** Model a live stream: stays open (polling) until the run ends. */
  holdStream?: boolean;
}

function fakeClient(opts: FakeOptions = {}) {
  const events = opts.events ?? [];
  const hold = opts.holdStream ?? false;
  const calls = {
    get: vi.fn(async () => {
      if (opts.getThrows) throw new Error("session not found");
      return { id: SID, agent: "build", model: { id: "fledge-alpha-free", providerID: "opencode" } };
    }),
    create: vi.fn(async () => ({
      id: SID,
      agent: "build",
      model: { id: "fledge-alpha-free", providerID: "opencode" },
    })),
    switchAgent: vi.fn(async () => undefined),
    switchModel: vi.fn(async () => undefined),
    prompt: vi.fn(async () => {
      if (opts.promptThrows) throw new Error("409 conflict");
      return { id: "msg_1", sessionID: SID, type: "user", payload: { text: "p" }, delivery: "steer", time: { created: 1 } };
    }),
    interrupt: vi.fn(async () => ({ interrupted: true })),
    reply: vi.fn(async () => undefined),
    subscribe: vi.fn(() => ({
      [Symbol.asyncIterator]() {
        let i = 0;
        let closed = false;
        return {
          async next() {
            for (;;) {
              if (i < events.length) {
                const value = events[i++] as OpenCodeEvent;
                await Promise.resolve();
                return { done: false, value };
              }
              if (!hold || closed) return { done: true, value: undefined };
              // A live stream delivers later events; poll so a test can push
              // the event a real service sends after an interrupt.
              await new Promise<void>((res) => setTimeout(res, 2));
            }
          },
          async return() {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    })),
  };
  const client = {
    session: {
      get: calls.get,
      create: calls.create,
      switchAgent: calls.switchAgent,
      switchModel: calls.switchModel,
      prompt: calls.prompt,
      interrupt: calls.interrupt,
    },
    permission: { reply: calls.reply },
    event: { subscribe: calls.subscribe },
  };
  // `events` is handed back so a test can inject the event a real service
  // would send in response to something the runner did (e.g. an interrupt).
  return { client: client as never, calls, events };
}

function runArgs(extra: Partial<Parameters<typeof runOpencodeHarness>[0]> = {}) {
  const items: unknown[] = [];
  return {
    items,
    req: {
      prompt: "do the thing",
      cwd: "/tmp/opencode/spike/ws",
      mode: "edit",
      resumeId: null,
      model: undefined,
      signal: new AbortController().signal,
      onItems: (i: unknown[]) => items.push(i),
      ...extra,
    },
  };
}

const fullTurn: OpenCodeEvent[] = [
  serverConnected,
  toolInputStarted,
  toolCalled,
  reasoningDelta,
  textDelta,
  usageUpdated,
  executionSucceeded,
];

/** Let pending microtasks/timers settle until `cond` holds (or fail fast). */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise<void>((res) => setTimeout(res, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("runOpencodeHarness", () => {
  it("creates a session in the workspace with allow-all permissions", async () => {
    const { client, calls } = fakeClient({ events: fullTurn });
    const { req } = runArgs();
    const outcome = await runOpencodeHarness(req, client);

    expect(outcome).toEqual({ code: 0, sessionId: SID });
    expect(calls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        location: { directory: "/tmp/opencode/spike/ws" },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      }),
    );
  });

  it("streams queue items in order and resolves the tool name", async () => {
    const { client } = fakeClient({ events: fullTurn });
    const { req, items } = runArgs();
    await runOpencodeHarness(req, client);

    expect(items).toEqual([
      [["tool", { tool: "write", detail: "cap.txt", path: "/tmp/opencode/spike/ws/cap.txt" }]],
      [["thinking", 'The user wants me to write "hello" into a file named cap.']],
      [["chunk", "Wrote `hello` to `cap.txt`."]],
      [["usage", { prompt_tokens: 7485, completion_tokens: 98 }]],
    ]);
  });

  it("sends the prompt text with steer delivery", async () => {
    const { client, calls } = fakeClient({ events: fullTurn });
    const { req } = runArgs();
    await runOpencodeHarness(req, client);
    expect(calls.prompt).toHaveBeenCalledWith({
      sessionID: SID,
      text: "do the thing",
      delivery: "steer",
    });
  });

  it("selects the mode agent and switches away from a different one", async () => {
    const { client, calls } = fakeClient({ events: fullTurn });
    const { req } = runArgs({ mode: "chat" });
    await runOpencodeHarness(req, client);
    expect(calls.switchAgent).toHaveBeenCalledWith({ sessionID: SID, agent: "plan" });
  });

  it("switches the model when the setting differs from the session's", async () => {
    const { client, calls } = fakeClient({ events: fullTurn });
    const { req } = runArgs({ model: "anthropic/claude-sonnet-4-5" });
    await runOpencodeHarness(req, client);
    expect(calls.switchModel).toHaveBeenCalledWith({
      sessionID: SID,
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
    });
  });

  it("leaves the model alone when it matches or is unparseable", async () => {
    const { client, calls } = fakeClient({ events: fullTurn });
    const same = runArgs({ model: "opencode/fledge-alpha-free" });
    await runOpencodeHarness(same.req, client);
    const noSlash = runArgs({ model: "gpt-6-sol" });
    await runOpencodeHarness(noSlash.req, client);
    expect(calls.switchModel).not.toHaveBeenCalled();
  });

  it("reuses a mapped session instead of creating one", async () => {
    const { client, calls } = fakeClient({ events: fullTurn });
    const { req } = runArgs({ resumeId: SID });
    const outcome = await runOpencodeHarness(req, client);

    expect(calls.get).toHaveBeenCalledWith({ sessionID: SID });
    expect(calls.create).not.toHaveBeenCalled();
    expect(outcome.sessionId).toBe(SID);
  });

  it("falls back to a new session when the mapped one is gone", async () => {
    const { client, calls } = fakeClient({ events: fullTurn, getThrows: true });
    const { req } = runArgs({ resumeId: "ses_gone" });
    const outcome = await runOpencodeHarness(req, client);

    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ code: 0, sessionId: SID });
  });

  it("answers permission asks with allow", async () => {
    const events = [...fullTurn.slice(0, 2), permissionAsked, ...fullTurn.slice(2)];
    const { client, calls } = fakeClient({ events });
    const { req } = runArgs();
    await runOpencodeHarness(req, client);
    expect(calls.reply).toHaveBeenCalledWith({
      sessionID: SID,
      requestID: "per_1",
      decision: "once",
    });
  });

  it("keeps a model-level failure as a successful run so the session stays resumable", async () => {
    const events = [textDelta, usageUpdated, executionFailed];
    const { client, calls } = fakeClient({ events });
    const { req, items } = runArgs();
    const outcome = await runOpencodeHarness(req, client);

    expect(outcome.code).toBe(0);
    expect(items).toContainEqual([["error_text", "rate limited"]]);
    expect(calls.interrupt).not.toHaveBeenCalled();
  });

  it("interrupts the session when the run is aborted", async () => {
    const controller = new AbortController();
    // A stream that never ends on its own: only the interrupt frees the run,
    // which is what the stop button depends on.
    const { client, calls, events } = fakeClient({ events: [], holdStream: true });
    calls.interrupt.mockImplementation(async () => {
      // What the real service sends back once the turn is cut short.
      events.push(executionInterrupted);
      return { interrupted: true };
    });
    const { req } = runArgs({ signal: controller.signal });
    const pending = runOpencodeHarness(req, client);
    // The abort listener is attached just before the prompt is sent.
    await until(() => calls.prompt.mock.calls.length > 0, "the prompt to be sent");
    controller.abort();

    expect(calls.interrupt).toHaveBeenCalledWith({ sessionID: SID });
    await expect(pending).resolves.toEqual({ code: 0, sessionId: SID });
  });

  it("reports a prompt rejection as a transport failure", async () => {
    const { client } = fakeClient({ events: [], promptThrows: true });
    const { req } = runArgs();
    const outcome = await runOpencodeHarness(req, client);
    expect(outcome.code).toBe(1);
    expect(outcome.error).toContain("409 conflict");
  });
});

// --- models ---------------------------------------------------------------

describe("listOpencodeModels", () => {
  it("lists provider/model ids and flags an empty service listing as manual", async () => {
    // getOpencodeClient() talks to the developer's own service, so assert only
    // the shape contract that the Settings dropdown relies on.
    const result = await listOpencodeModels("/tmp/opencode/spike/ws");
    expect(Array.isArray(result.models)).toBe(true);
    expect(result.manual).toBe(result.models.length === 0);
    for (const m of result.models) {
      expect(m.id).toMatch(/^[^/]+\/.+/);
      expect(typeof m.name).toBe("string");
    }
  });
});
