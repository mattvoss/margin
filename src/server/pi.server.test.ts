// @vitest-environment node
//
// The Pi transport embeds `@earendil-works/pi-coding-agent` in-process, so the
// SDK is mocked here: these tests assert the mapping and session/turn wiring
// against the shapes the SDK actually emits, without credentials, a network,
// or files under ~/.pi.

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- SDK doubles ------------------------------------------------------------
// vi.mock is hoisted above every top-level declaration, so the shared state and
// the fakes it closes over have to be created inside vi.hoisted too.

const h = vi.hoisted(() => {
  const state = {
    sdkVersion: "1.0.4",
    sessionManagerArgs: [] as { cwd?: string }[],
    findByIdCalls: [] as { cwd: string; id: string }[],
    persistedPath: null as string | null,
    createOptions: [] as Record<string, unknown>[],
    listeners: [] as ((ev: unknown) => void)[],
    promptImpl: null as ((text: string) => Promise<void>) | null,
    noModels: false,
    runtimeThrows: null as Error | null,
    agentDir: "/tmp/opencode/pi/agent-nonexistent",
    disposed: 0,
    aborted: 0,
    createThrows: null as Error | null,
  };

  class FakeSessionManager {
    private readonly sessionId: string;
    constructor(sessionId: string) {
      this.sessionId = sessionId;
    }
    getSessionId() {
      return this.sessionId;
    }
    static findById(cwd: string, id: string) {
      state.findByIdCalls.push({ cwd, id });
      return state.persistedPath;
    }
    static open(path: string) {
      state.sessionManagerArgs.push({ cwd: `open:${path}` });
      return new FakeSessionManager("pi_resumed");
    }
    static create(cwd: string) {
      state.sessionManagerArgs.push({ cwd });
      return new FakeSessionManager("pi_fresh");
    }
  }

  function fakeSession() {
    return {
      session: {
        subscribe: (fn: (ev: unknown) => void) => {
          state.listeners.push(fn);
          return () => {
            state.listeners = state.listeners.filter((l) => l !== fn);
          };
        },
        prompt: async (text: string) => {
          if (state.promptImpl) await state.promptImpl(text);
        },
        abort: async () => {
          state.aborted++;
        },
        dispose: () => {
          state.disposed++;
        },
      },
      extensionsResult: {},
    };
  }

  return { state, FakeSessionManager, fakeSession };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  // A getter so a test can exercise the version-placeholder path.
  get VERSION() {
    return h.state.sdkVersion;
  },
  // Points the config backfill at a path with no Pi files, so discovery tests
  // stay hermetic. The dedicated tests pass their own temp directory.
  getAgentDir: () => h.state.agentDir,
  SessionManager: h.FakeSessionManager,
  createAgentSession: async (opts: Record<string, unknown>) => {
    h.state.createOptions.push(opts);
    if (h.state.createThrows) throw h.state.createThrows;
    return h.fakeSession();
  },
  ModelRuntime: {
    create: async () => {
      if (h.state.runtimeThrows) throw h.state.runtimeThrows;
      return {
        providerIds: () => new Set<string>(),
        registerProvider: () => {},
        unregisterProvider: () => {},
        refresh: async () => ({}),
        getModel: (provider: string, id: string) =>
          provider === "anthropic" && id === "claude-x" ? { provider, id } : undefined,
        getAvailableOfType: async () =>
          h.state.noModels
            ? []
            : [{ provider: "anthropic", id: "claude-x", name: "Claude X" }],
      };
    },
  },
}));

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listPiModels,
  mapPiEvent,
  piReady,
  registerPersistedProviders,
  resolvePiSessionManager,
  runPiHarness,
} from "./pi.server";
import type { PiEventContext, PiRunRequest } from "./pi.server";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { HarnessQueueItem } from "./harness.server";

const CWD = "/tmp/opencode/pi/ws";
const s = h.state;

function ctx(): PiEventContext {
  return { seenUsage: new Set() };
}

/** Casts a loose object to the event union: the mapper reads it defensively. */
function ev(partial: Record<string, unknown>): AgentSessionEvent {
  return partial as unknown as AgentSessionEvent;
}

function delta(type: string, d: string): AgentSessionEvent {
  return ev({ type: "message_update", assistantMessageEvent: { type, delta: d } });
}

function run(overrides: Partial<PiRunRequest> = {}) {
  const items: HarnessQueueItem[] = [];
  const req: PiRunRequest = {
    prompt: "rewrite this",
    cwd: CWD,
    mode: "edit",
    resumeId: null,
    model: undefined,
    signal: new AbortController().signal,
    onItems: (i) => items.push(...i),
    ...overrides,
  };
  return { items, outcome: runPiHarness(req) };
}

beforeEach(() => {
  s.sdkVersion = "1.0.4";
  s.sessionManagerArgs.length = 0;
  s.findByIdCalls.length = 0;
  s.createOptions = [];
  s.listeners = [];
  s.promptImpl = null;
  s.noModels = false;
  s.runtimeThrows = null;
  s.agentDir = "/tmp/opencode/pi/agent-nonexistent";
  s.persistedPath = null;
  s.createThrows = null;
  s.disposed = 0;
  s.aborted = 0;
});

// --- event mapping ----------------------------------------------------------

describe("mapPiEvent", () => {
  it("maps text and thinking deltas to their own queues", () => {
    expect(mapPiEvent(delta("text_delta", "Hello"), ctx())).toEqual([["chunk", "Hello"]]);
    expect(mapPiEvent(delta("thinking_delta", "hmm"), ctx())).toEqual([["thinking", "hmm"]]);
  });

  it("ignores other assistant message events", () => {
    for (const t of ["start", "text_start", "text_end", "thinking_end"]) {
      expect(mapPiEvent(delta(t, "ignored"), ctx())).toEqual([]);
    }
    // A delta-shaped payload on an unknown inner type is not streamed.
    expect(mapPiEvent(delta("something_new", "ignored"), ctx())).toEqual([]);
  });

  it("maps a tool start to name + detail + raw path", () => {
    const e = ev({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "write",
      args: { path: `${CWD}/cap.txt`, content: "x" },
    });
    expect(mapPiEvent(e, ctx())).toEqual([
      ["tool", { tool: "write", detail: "cap.txt", path: `${CWD}/cap.txt` }],
    ]);
  });

  it("surfaces tool failures as error text", () => {
    const e = ev({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "edit",
      isError: true,
      result: { error: "no such file" },
    });
    expect(mapPiEvent(e, ctx())).toEqual([["error_text", "edit failed: no such file"]]);
  });

  it("stays quiet on a successful tool end", () => {
    const e = ev({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", isError: false });
    expect(mapPiEvent(e, ctx())).toEqual([]);
  });

  it("reports usage once even though message_end and turn_end both carry it", () => {
    const message = { usage: { input: 11, output: 7 }, responseId: "resp_1", timestamp: 1 };
    const c = ctx();
    expect(mapPiEvent(ev({ type: "message_end", message }), c)).toEqual([
      ["usage", { prompt_tokens: 11, completion_tokens: 7 }],
    ]);
    // Same message on the following turn_end must not count twice.
    expect(mapPiEvent(ev({ type: "turn_end", message }), c)).toEqual([]);
  });

  it("counts a later assistant message separately", () => {
    const c = ctx();
    const first = { usage: { input: 5, output: 1 }, responseId: "resp_1", timestamp: 1 };
    const second = { usage: { input: 9, output: 2 }, responseId: "resp_2", timestamp: 2 };
    expect(mapPiEvent(ev({ type: "message_end", message: first }), c)).toHaveLength(1);
    expect(mapPiEvent(ev({ type: "message_end", message: second }), c)).toEqual([
      ["usage", { prompt_tokens: 9, completion_tokens: 2 }],
    ]);
  });

  it("turns a model-level failure into error text", () => {
    const e = ev({
      type: "message_end",
      message: { usage: { input: 3, output: 0 }, errorMessage: "rate limited", responseId: "r" },
    });
    expect(mapPiEvent(e, ctx())).toEqual([
      ["error_text", "rate limited"],
      ["usage", { prompt_tokens: 3, completion_tokens: 0 }],
    ]);
  });

  it("ignores lifecycle events margin does not display", () => {
    for (const t of ["agent_start", "agent_end", "agent_settled", "turn_start", "entry_appended"]) {
      expect(mapPiEvent(ev({ type: t }), ctx())).toEqual([]);
    }
  });
});

// --- session resolution -----------------------------------------------------

describe("resolvePiSessionManager", () => {
  it("creates a fresh session when there is nothing to resume", () => {
    expect(resolvePiSessionManager(CWD, null).getSessionId()).toBe("pi_fresh");
    expect(s.sessionManagerArgs).toEqual([{ cwd: CWD }]);
  });

  it("reopens the recorded session scoped to the workspace", () => {
    s.persistedPath = "/home/u/.pi/agent/sessions/ws/pi_old.jsonl";
    expect(resolvePiSessionManager(CWD, "pi_old").getSessionId()).toBe("pi_resumed");
    expect(s.findByIdCalls).toEqual([{ cwd: CWD, id: "pi_old" }]);
    expect(s.sessionManagerArgs).toEqual([{ cwd: `open:${s.persistedPath}` }]);
  });

  it("starts clean when the recorded session no longer exists", () => {
    s.persistedPath = null;
    expect(resolvePiSessionManager(CWD, "pi_gone").getSessionId()).toBe("pi_fresh");
    expect(s.sessionManagerArgs).toEqual([{ cwd: CWD }]);
  });
});

// --- run --------------------------------------------------------------------

describe("runPiHarness", () => {
  it("streams a turn, then disposes the session", async () => {
    s.promptImpl = async () => {
      s.listeners.forEach((l) => l(delta("text_delta", "all done")));
    };
    const { items, outcome } = run();
    const result = await outcome;

    expect(result.code).toBe(0);
    expect(result.sessionId).toBe("pi_fresh");
    expect(items).toEqual([["chunk", "all done"]]);
    expect(s.disposed).toBe(1);
    // The turn is over: the listener is detached.
    expect(s.listeners).toHaveLength(0);
  });

  it("gives edit mode the write tools and chat mode none", async () => {
    await run({ mode: "edit" }).outcome;
    expect(s.createOptions[0]?.tools).toEqual(["read", "bash", "edit", "write"]);

    s.createOptions = [];
    await run({ mode: "chat" }).outcome;
    expect(s.createOptions[0]?.tools).toEqual(["read", "grep", "find", "ls"]);
  });

  it("passes the workspace cwd and the resolved model to the session", async () => {
    await run({ model: "anthropic/claude-x" }).outcome;
    expect(s.createOptions[0]?.cwd).toBe(CWD);
    expect(s.createOptions[0]?.model).toEqual({ provider: "anthropic", id: "claude-x" });
  });

  it("leaves the model unset when the configured one is unknown", async () => {
    // An unrecognized model must not fail the run: Pi keeps its own default.
    await run({ model: "nope/missing" }).outcome;
    expect(s.createOptions[0]?.model).toBeUndefined();
  });

  it("resumes the recorded session", async () => {
    s.persistedPath = "/home/u/.pi/agent/sessions/ws/pi_old.jsonl";
    const result = await run({ resumeId: "pi_old" }).outcome;
    expect(result.sessionId).toBe("pi_resumed");
  });

  it("aborts the session when the request is cancelled", async () => {
    const ctrl = new AbortController();
    s.promptImpl = async () => {
      ctrl.abort();
    };
    const result = await run({ signal: ctrl.signal }).outcome;
    expect(s.aborted).toBeGreaterThan(0);
    expect(result.code).toBe(0);
  });

  it("reports a setup failure as code 1", async () => {
    s.createThrows = new Error("no credentials");
    const result = await run().outcome;
    expect(result.code).toBe(1);
    expect(result.error).toBe("no credentials");
    // Nothing was created, so there is nothing to dispose.
    expect(s.disposed).toBe(0);
  });

  it("keeps a model-level failure resumable rather than fatal", async () => {
    s.promptImpl = async () => {
      s.listeners.forEach((l) =>
        l(ev({ type: "message_end", message: { usage: { input: 1, output: 0 }, errorMessage: "429" } })),
      );
    };
    const { items, outcome } = run();
    const result = await outcome;
    // code 0 keeps the chat resumable; dispatch marks the log failed on error_text.
    expect(result.code).toBe(0);
    expect(items[0]).toEqual(["error_text", "429"]);
  });
});

// --- discovery --------------------------------------------------------------

describe("discovery", () => {
  it("lists usable models as provider/model", async () => {
    const result = await listPiModels();
    expect(result.models).toEqual([{ id: "anthropic/claude-x", name: "Claude X" }]);
    expect(result.manual).toBe(false);
  });

  it("reports ready with the SDK version", async () => {
    const ready = await piReady();
    expect(ready.ready).toBe(true);
    expect(ready.version).toBe("1.0.4");
  });

  it("reports no version when the bundle lost the package version", async () => {
    // The SDK falls back to this placeholder when its package.json is inlined.
    s.sdkVersion = "0.0.0";
    const ready = await piReady();
    expect(ready.ready).toBe(true);
    expect(ready.version).toBeNull();
  });

  it("reports the sign-in hint when no model is usable", async () => {
    s.noModels = true;
    const ready = await piReady();
    expect(ready.ready).toBe(false);
    expect(ready.error).toMatch(/pi` CLI/);
    // The settings dialog falls back to a free-text box for the model.
    expect((await listPiModels()).manual).toBe(true);
  });

  it("reports the real cause when the runtime fails to load", async () => {
    // The runtime promise is cached per module, so this needs a fresh copy.
    s.runtimeThrows = new Error("auth.json unreadable");
    vi.resetModules();
    const fresh = await import("./pi.server");
    const ready = await fresh.piReady();
    expect(ready.ready).toBe(false);
    // The underlying cause survives the "sign in again" wrapper.
    expect(ready.error).toMatch(/auth\.json unreadable/);
    // ...and the settings dialog still falls back to a free-text box.
    expect((await fresh.listPiModels()).manual).toBe(true);
  });
});

// --- extension-provider backfill --------------------------------------------

describe("registerPersistedProviders", () => {
  const chatModel = {
    id: "unsloth/gemma",
    name: "unsloth/gemma",
    api: "openai-completions",
    baseUrl: "https://llama.example/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 65536,
    maxTokens: 65536,
  };

  /** A fake runtime that records what the backfill registers. */
  function fakeRuntime(known: string[] = []) {
    const registered: { id: string; config: { apiKey?: string; models: unknown[] } }[] = [];
    return {
      registered,
      runtime: {
        providerIds: () => new Set(known),
        registerProvider: (id: string, config: { apiKey?: string; models: unknown[] }) =>
          registered.push({ id, config }),
        refresh: vi.fn(async () => ({})),
      },
    };
  }

  async function agentDirWith(files: Record<string, unknown>) {
    const dir = await mkdtemp(join(tmpdir(), "pi-agent-"));
    for (const [name, value] of Object.entries(files)) {
      await writeFile(join(dir, name), JSON.stringify(value));
    }
    return dir;
  }

  it("restores an extension provider from Pi's persisted state", async () => {
    const dir = await agentDirWith({
      "auth.json": { "llama.cpp": { type: "api_key", key: "1" } },
      "models-store.json": {
        "llama.cpp": { models: [chatModel, { ...chatModel, type: "classifier", api: "llama-cpp-classify" }] },
      },
    });
    const { registered, runtime } = fakeRuntime();

    await registerPersistedProviders(runtime as never, dir);

    expect(registered.map((r) => r.id)).toEqual(["llama.cpp"]);
    expect(registered[0]?.config.apiKey).toBe("1");
    // The classifier twin shares the id but is not a chat model.
    expect(registered[0]?.config.models).toHaveLength(1);
    expect(runtime.refresh).toHaveBeenCalledOnce();
  });

  it("leaves providers the runtime already knows untouched", async () => {
    const dir = await agentDirWith({
      "models-store.json": { "llama.cpp": { models: [chatModel] } },
    });
    const { registered, runtime } = fakeRuntime(["llama.cpp"]);

    await registerPersistedProviders(runtime as never, dir);

    expect(registered).toEqual([]);
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it("is a no-op when Pi has no persisted catalog", async () => {
    const dir = await agentDirWith({});
    const { registered, runtime } = fakeRuntime();

    await expect(registerPersistedProviders(runtime as never, dir)).resolves.toBeUndefined();

    expect(registered).toEqual([]);
    expect(runtime.refresh).not.toHaveBeenCalled();
  });
});