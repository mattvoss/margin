/* eslint-disable @typescript-eslint/no-explicit-any, no-control-regex */
// The CLI stream parsers below decode untyped JSONL from third-party harnesses:
// `any` and the ANSI-stripping control-char regex are deliberate there. The rest
// of this file (registry, discovery, transports) is fully typed.

// Agent-harness plumbing for TanStack Start (Docker on Linux only, Node 22).
//
// TypeScript port of the Python harness layer. Export-to-source map:
// - api/services/harness_registry.py -> HARNESS_DESCRIPTORS (descriptors copied
//   verbatim: command/subcommand/resume/model/agent/format/workspace/extra/
//   prompt/cwd flags; pi is newer than the Python layer and has no argv)
// - api/services/harness_env.py -> normalizedEnv (internal), whichHarness
// - api/routers/harnesses.py -> detectVersion (_detect_version),
//   resolveHarnessExe (_resolve_harness_exe), listHarnesses (list_harnesses),
//   parseModelsOutput (_parse_models_output), getHarnessModels (harness_models)
// - api/routers/assist.py -> resolveHarnessArgv (_resolve_harness_argv),
//   stripAnsi (_strip_ansi), summarizeToolInput (_summarize_tool_input),
//   toolEventPath (_tool_event_path), runHarnessSync (_run_harness_sync),
//   parseHarnessLine + parseOpencodeLine / parseAgyLine / parseClaudeLine /
//   parseCodexLine (_parse_opencode_line / _parse_agy_line /
//   _parse_claude_line / _parse_codex_line)
//
// Only node:child_process (spawn/execFile), node:fs, node:path are imported,
// plus lazy dynamic imports of the two in-process transports (the OpenCode
// client and the Pi SDK).

import { execFile, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Registry (api/services/harness_registry.py)
// ---------------------------------------------------------------------------

/**
 * How a harness is driven:
 * - `cli` spawns a program and parses its stream
 * - `opencode` talks to the OpenCode service over @opencode/client
 * - `pi` embeds the agent in-process via @earendil-works/pi-coding-agent
 */
export type HarnessTransport = "cli" | "opencode" | "pi";

export interface HarnessDescriptor {
  name: string;
  transport?: HarnessTransport;
  command: string;
  version_args?: string[];
  models_args?: string[];
  static_models?: string[];
  subcommand?: string;
  workspace_flag?: string;
  prompt_flag?: string;
  model_flag?: string;
  cwd_flag?: string;
  agent_flag?: string;
  mode_agents?: Record<string, string>;
  /**
   * Tool allowlist per mode, for SDK harnesses that gate tools instead of
   * swapping agents. `pi` uses it to keep Chat read-only.
   */
  mode_tools?: Record<string, string[]>;
  extra_args?: string[];
  resume_flag?: string;
  resume_subcommand?: string;
  stream?: string;
  format_args?: string[];
}

export const HARNESS_DESCRIPTORS: Record<string, HarnessDescriptor> = {
  opencode: {
    name: "OpenCode",
    // Talks to the OpenCode service over @opencode/client — no CLI subprocess.
    // The descriptor keeps only what the transport still needs (mode agents).
    transport: "opencode",
    command: "opencode",
    mode_agents: { chat: "plan", edit: "build" },
  },
  pi: {
    name: "Pi",
    // Embedded in-process through the Pi SDK — no CLI subprocess, no argv.
    // The descriptor keeps only what the transport still needs: the per-mode
    // tool allowlist. Chat stays read-only so it can't touch the manuscript;
    // edit gets Pi's coding set (read, bash, edit, write).
    transport: "pi",
    command: "pi",
    mode_tools: {
      chat: ["read", "grep", "find", "ls"],
      edit: ["read", "bash", "edit", "write"],
    },
  },
  "claude-code": {
    name: "Claude Code",
    command: "claude",
    version_args: ["--version"],
    models_args: [],
    static_models: [
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ],
    prompt_flag: "-p",
    model_flag: "--model",
    stream: "claude",
    format_args: ["--output-format", "stream-json", "--verbose"],
    extra_args: ["--permission-mode", "acceptEdits"],
    resume_flag: "--resume",
  },
  codex: {
    name: "Codex",
    command: "codex",
    version_args: ["--version"],
    models_args: [],
    static_models: [
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
    ],
    subcommand: "exec",
    workspace_flag: "-C",
    model_flag: "-m",
    stream: "codex",
    format_args: ["--json"],
    extra_args: ["-s", "workspace-write"],
    resume_subcommand: "resume",
  },
  agy: {
    name: "Antigravity",
    command: "agy",
    version_args: ["--version"],
    models_args: ["models"],
    workspace_flag: "--add-dir",
    prompt_flag: "--print",
    model_flag: "--model",
    extra_args: ["--mode", "accept-edits", "--dangerously-skip-permissions"],
    stream: "agy",
    format_args: ["--output-format", "stream-json"],
    resume_flag: "--conversation",
  },
};

export type HarnessOverrides = Record<string, { executable?: string; model?: string }>;

export interface HarnessSettings {
  harnesses?: HarnessOverrides;
}

export interface HarnessInfo {
  id: string;
  name: string;
  available: boolean;
  version: string | null;
  models_supported?: boolean;
}

export interface HarnessModel {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Environment (api/services/harness_env.py — Linux only, no .exe handling)
// ---------------------------------------------------------------------------

const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export function normalizedEnv(): typeof process.env {
  const env = { ...process.env };
  const parts = (env.PATH ?? "").split(delimiter).filter((p) => p.length > 0);
  const extras = [...EXTRA_BIN_DIRS];
  const home = process.env.HOME?.trim();
  if (home) extras.push(join(home, ".local", "bin"));
  for (const d of extras) {
    if (!parts.includes(d)) parts.push(d);
  }
  env.PATH = parts.join(delimiter);
  return env;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Locate a harness executable via PATH scan (Linux only, no .exe suffix). */
export function whichHarness(command: string): string | null {
  if (command.includes("/")) {
    return isExecutable(command) ? command : null;
  }
  const pathValue = normalizedEnv().PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discovery (api/routers/harnesses.py)
// ---------------------------------------------------------------------------

/** Run `<exe> ...args`, return the first output line (max 80 chars) or null. */
export function detectVersion(exe: string, args: string[]): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(exe, args, { timeout: 5000, env: normalizedEnv() }, (error, stdout, stderr) => {
      if (error) {
        resolvePromise(null);
        return;
      }
      const out = String(stdout || stderr).trim();
      if (!out) {
        resolvePromise(null);
        return;
      }
      resolvePromise(out.split("\n")[0].slice(0, 80));
    });
  });
}

/** Custom executable from settings when it exists and is executable, else PATH. */
export function resolveHarnessExe(harnessId: string, overrides: HarnessOverrides = {}): string | null {
  const desc = HARNESS_DESCRIPTORS[harnessId];
  if (!desc) throw new Error(`Unknown harness: ${harnessId}`);
  const custom = overrides[harnessId]?.executable;
  if (custom && isExecutable(custom)) return custom;
  return whichHarness(desc.command);
}

/**
 * True for harnesses driven in-process or over a service instead of a spawned
 * CLI — they have no command line, so no argv, no PATH lookup, and a different
 * model-listing source.
 */
export function isServiceTransport(harnessId: string): boolean {
  const transport = HARNESS_DESCRIPTORS[harnessId]?.transport;
  return transport === "opencode" || transport === "pi";
}

/**
 * Readiness probe for a service-backed harness. Each branch lazy-imports its
 * client so `@opencode/client` and the Pi SDK stay out of the startup path.
 */
async function serviceReady(
  harnessId: string,
): Promise<{ ready: boolean; version: string | null; error?: string }> {
  if (HARNESS_DESCRIPTORS[harnessId]?.transport === "pi") {
    const { piReady } = await import("./pi.server");
    return piReady();
  }
  const { opencodeReady } = await import("./opencode.server");
  return opencodeReady();
}

export async function listHarnesses(settings?: HarnessSettings | null): Promise<HarnessInfo[]> {
  const overrides = settings?.harnesses ?? {};
  const result: HarnessInfo[] = [];
  for (const [hid, desc] of Object.entries(HARNESS_DESCRIPTORS)) {
    if (isServiceTransport(hid)) {
      const ready = await serviceReady(hid);
      result.push({
        id: hid,
        name: desc.name,
        available: ready.ready,
        version: ready.version,
        models_supported: true,
      });
      continue;
    }
    const exe = resolveHarnessExe(hid, overrides);
    result.push({
      id: hid,
      name: desc.name,
      available: Boolean(exe),
      version: exe ? await detectVersion(exe, desc.version_args ?? ["--version"]) : null,
      models_supported: (desc.static_models?.length ?? 0) > 0 || (desc.models_args?.length ?? 0) > 0,
    });
  }
  return result;
}

/** Parse `provider/model` lines (opencode) or `id<TAB>Name` lines (agy). */
export function parseModelsOutput(text: string): HarnessModel[] {
  const models: HarnessModel[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const first = line.split(/\s+/)[0];
    if (!first.includes("/") && !first.includes("-")) continue; // progress chatter, headers, etc.
    const match = /^(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const id = match[1];
    const name = (match[2] ?? "").trim() || id;
    models.push({ id, name });
  }
  return models.slice(0, 100);
}

export function getHarnessModels(
  harnessId: string,
  exe: string | null,
  workspaceDir?: string,
): Promise<{ models: HarnessModel[]; manual: boolean }> {
  const desc = HARNESS_DESCRIPTORS[harnessId];
  if (!desc) throw new Error(`Unknown harness: ${harnessId}`);
  if (isServiceTransport(harnessId)) {
    // OpenCode lists models per workspace from its service; Pi's catalog is
    // global, so only OpenCode needs the directory.
    if (HARNESS_DESCRIPTORS[harnessId]?.transport === "pi") {
      return import("./pi.server").then((m) => m.listPiModels());
    }
    if (!workspaceDir) return Promise.resolve({ models: [], manual: true });
    return import("./opencode.server").then((m) => m.listOpencodeModels(workspaceDir));
  }
  if (desc.static_models && desc.static_models.length > 0) {
    return Promise.resolve({
      models: desc.static_models.map((m) => ({ id: m, name: m })),
      manual: false,
    });
  }
  const modelsArgs = desc.models_args ?? [];
  if (!exe || modelsArgs.length === 0) {
    return Promise.resolve({ models: [], manual: true });
  }
  return new Promise((resolvePromise) => {
    execFile(exe, modelsArgs, { timeout: 15000, env: normalizedEnv() }, (error, stdout) => {
      if (error) {
        resolvePromise({ models: [], manual: true });
        return;
      }
      const models = parseModelsOutput(stdout || "");
      resolvePromise({ models, manual: models.length === 0 });
    });
  });
}

// ---------------------------------------------------------------------------
// Execution helpers (api/routers/assist.py)
// ---------------------------------------------------------------------------

/**
 * Build argv for a CLI harness. Flag order mirrors _resolve_harness_argv
 * exactly: exe, subcommand, resume, model, agent, format_args, workspace,
 * extra_args, prompt (via prompt_flag, else `--` positional), cwd_flag. The
 * prompt is always last except for cwd_flag — agy's --print swallows the next
 * arg, so no flag may follow it (agy has no cwd_flag).
 */
export function resolveHarnessArgv(
  harnessId: string,
  prompt: string,
  cwd: string,
  mode = "edit",
  resumeId?: string | null,
  overrides: HarnessOverrides = {},
): string[] {
  const desc = HARNESS_DESCRIPTORS[harnessId];
  if (!desc) throw new Error(`Unknown harness: ${harnessId}`);
  if (isServiceTransport(harnessId)) {
    throw new Error(`${desc.name} runs in-process — it has no command line`);
  }
  const exe = resolveHarnessExe(harnessId, overrides);
  if (!exe) {
    throw new Error(`${desc.name} not found — install it or set a custom path in Settings > Harnesses`);
  }
  const argv: string[] = [exe];
  if (desc.subcommand) argv.push(desc.subcommand);
  if (resumeId) {
    if (desc.resume_subcommand) argv.push(desc.resume_subcommand, resumeId);
    else if (desc.resume_flag) argv.push(desc.resume_flag, resumeId);
  }
  const model = overrides[harnessId]?.model;
  if (model && desc.model_flag) argv.push(desc.model_flag, model);
  const agent = desc.mode_agents?.[mode];
  if (agent && desc.agent_flag) argv.push(desc.agent_flag, agent);
  if (desc.format_args) argv.push(...desc.format_args);
  if (desc.workspace_flag) argv.push(desc.workspace_flag, cwd);
  if (desc.extra_args) argv.push(...desc.extra_args);
  if (desc.prompt_flag) argv.push(desc.prompt_flag, prompt);
  else argv.push("--", prompt);
  if (desc.cwd_flag) argv.push(desc.cwd_flag, cwd);
  return argv;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g;

/** Strip ANSI escape sequences so chat output/history stays readable. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export interface ToolCallState {
  input?: Record<string, unknown> | null;
}

/** Compact one-line summary for a tool call (name + file, no content). */
export function summarizeToolInput(_tool: string, state?: ToolCallState | null): string {
  const inp = state?.input ?? {};
  for (const key of ["filePath", "file_path", "path", "file", "pattern", "command"]) {
    const val = inp[key];
    if (!val) continue;
    const s = String(val);
    if (s.includes("/") && key !== "command") return s.split("/").pop() ?? "";
    return s.slice(0, 80);
  }
  return "";
}

/**
 * Full file path from a tool input, workspace-relative when possible.
 * Unlike the Python version (which resolves against the server workspace),
 * the workspace dir is an explicit parameter.
 */
export function toolEventPath(workspaceDir: string, state?: ToolCallState | null): string {
  const inp = state?.input ?? {};
  for (const key of ["filePath", "file_path", "path", "file"]) {
    const val = inp[key];
    if (!val) continue;
    const p = String(val);
    const abs = isAbsolute(p) ? p : resolve(workspaceDir, p);
    const rel = relative(resolve(workspaceDir), abs);
    if (rel && rel !== ".." && !rel.startsWith("../")) return rel;
    return p; // already relative, or outside the workspace
  }
  return "";
}

export interface RunHarnessOptions {
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

export interface RunHarnessResult {
  code: number | null;
  lines: string[];
}

/**
 * Spawn argv (cwd, stdin ignored, stdout+stderr merged like the Python
 * stderr=STDOUT), line-buffer output, call onLine per line, and resolve
 * {code, lines}. An aborted AbortSignal kills the child (SIGTERM).
 */
export function runHarnessSync(
  argv: string[],
  cwd: string,
  opts: RunHarnessOptions = {},
): Promise<RunHarnessResult> {
  return new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    };
    const proc = spawn(argv[0], argv.slice(1), {
      cwd,
      env: normalizedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let buf = "";
    const pushLine = (text: string) => {
      const clean = text.endsWith("\r") ? text.slice(0, -1) : text;
      lines.push(clean);
      opts.onLine?.(clean);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        pushLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (err) => {
      cleanup();
      reject(err);
    });
    proc.on("close", (code) => {
      if (buf.length > 0) pushLine(buf);
      buf = "";
      cleanup();
      resolvePromise({ code, lines });
    });
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Stream parsers (api/routers/assist.py _parse_*_line)
// ---------------------------------------------------------------------------

export interface HarnessToolEvent {
  tool: string;
  detail: string;
  path: string | null;
}

export interface HarnessUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export type HarnessQueueItem =
  | ["chunk", string]
  | ["thinking", string]
  | ["tool", HarnessToolEvent]
  | ["session", string]
  | ["usage", HarnessUsage]
  | ["error_text", string];

/** Mutable per-run parser state (codex delta tracking + error dedupe). */
export type HarnessParserState = Record<string, string>;

/**
 * Name + one-line detail + raw path for a tool call. Every transport produces
 * this same shape — the CLI parsers below, OpenCode's event mapper, and Pi's —
 * so it lives here once instead of being copied per transport.
 *
 * Raw path passthrough: the Python `_queue_tool` relativizes against the server
 * workspace at parse time, but storage is not importable here (only
 * node:child_process/fs/path allowed), so the raw path is passed through and
 * callers relativize with `toolEventPath(workspaceDir, { input: { path } })`.
 */
export function harnessToolEvent(tool: string, input: Record<string, unknown>): HarnessToolEvent {
  let path: string | null = null;
  for (const key of ["filePath", "file_path", "path", "file"]) {
    const val = input[key];
    if (!val) continue;
    path = String(val);
    break;
  }
  return { tool, detail: summarizeToolInput(tool, { input }), path };
}

function queueTool(tool: string, inp: Record<string, unknown>): HarnessQueueItem {
  return ["tool", harnessToolEvent(tool, inp)];
}

// OpenCode and Pi have no line parsers: their transports are typed event
// streams, mapped in opencode.server.ts / pi.server.ts.

export function parseAgyLine(line: string): HarnessQueueItem[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let d: any;
  try {
    d = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const items: HarnessQueueItem[] = [];
  const cid = d?.conversation_id ?? d?.result?.conversation_id;
  if (cid) items.push(["session", String(cid)]);
  const event = d?.event;
  if (event === "step_update") {
    const step = d.step_update ?? {};
    const stype = step.step_type ?? "";
    if (stype === "agent_response") {
      const delta = step.text_delta ?? "";
      if (delta) items.push(["chunk", delta]);
    } else if (String(stype).includes("reasoning")) {
      const delta = step.text_delta ?? "";
      if (delta) items.push(["thinking", delta]);
    } else if (stype === "tool" && step.state === "DONE") {
      const params = step.tool_info?.parameters ?? {};
      let toolPath = "";
      for (const key of ["TargetFile", "AbsolutePath", "FilePath", "Path"]) {
        if (params[key]) {
          toolPath = String(params[key]);
          break;
        }
      }
      const detail = toolPath
        ? (toolPath.split("/").pop() ?? "")
        : String(params.Command ?? "").slice(0, 80);
      items.push(["tool", { tool: step.tool_name ?? "tool", detail, path: toolPath || null }]);
    }
    return items;
  }
  if (event === "result") {
    const res = d.result ?? {};
    if (res.status !== undefined && res.status !== null && res.status !== "SUCCESS") {
      const resp = String(res.response ?? "");
      if (resp) items.push(["error_text", stripAnsi(resp)]);
    }
    const usage = res.usage ?? {};
    if (Object.keys(usage).length > 0) {
      items.push(["usage", {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
      }]);
    }
    return items;
  }
  return items;
}

export function parseClaudeLine(line: string): HarnessQueueItem[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let d: any;
  try {
    d = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const items: HarnessQueueItem[] = [];
  if (d?.session_id) items.push(["session", String(d.session_id)]);
  if (d?.type === "assistant") {
    const blocks = d.message?.content ?? [];
    for (const block of blocks) {
      const btype = block?.type;
      if (btype === "text" && block.text) items.push(["chunk", block.text]);
      else if (btype === "thinking" && block.thinking) items.push(["thinking", block.thinking]);
      else if (btype === "tool_use") items.push(queueTool(block.name ?? "tool", block.input ?? {}));
    }
  } else if (d?.type === "result") {
    if (d.is_error) items.push(["error_text", stripAnsi(String(d.result ?? "Claude Code error"))]);
    const usage = d.usage ?? {};
    if (usage.input_tokens !== undefined && usage.input_tokens !== null) {
      items.push(["usage", {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
      }]);
    }
  }
  return items;
}

export function parseCodexLine(line: string, state: HarnessParserState = {}): HarnessQueueItem[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let d: any;
  try {
    d = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const items: HarnessQueueItem[] = [];
  if (d?.thread_id) items.push(["session", String(d.thread_id)]);
  const etype = d?.type ?? "";
  if (etype === "item.updated" || etype === "item.completed") {
    const item = d.item ?? {};
    const itype = item.type ?? "";
    if (itype === "agent_message" || itype === "reasoning") {
      const key = `${itype}:${item.id ?? ""}`;
      const text = item.text ?? "";
      const prev = state[key] ?? "";
      const delta = text.startsWith(prev) ? text.slice(prev.length) : text;
      state[key] = text;
      if (delta) items.push([itype === "agent_message" ? "chunk" : "thinking", delta]);
    } else if (itype === "file_change" && etype === "item.completed") {
      for (const change of item.changes ?? []) {
        const p = change?.path ?? "";
        if (!p) continue;
        const parts = String(p).split("/");
        items.push(["tool", {
          tool: change.kind ?? "edit",
          detail: parts[parts.length - 1],
          path: String(p),
        }]);
      }
    } else if (itype === "command_execution" && etype === "item.completed") {
      const cmd = String(item.command || "").slice(0, 80);
      items.push(["tool", { tool: "bash", detail: cmd, path: null }]);
    } else if (itype === "mcp_tool_call" && etype === "item.completed") {
      items.push(["tool", { tool: item.tool || "mcp", detail: item.server || "", path: null }]);
    }
  } else if (etype === "turn.completed") {
    const toks = d.usage ?? {};
    items.push(["usage", {
      prompt_tokens: toks.input_tokens ?? 0,
      completion_tokens: toks.output_tokens ?? 0,
    }]);
  } else if (etype === "turn.failed") {
    const msg = d.error?.message ?? "Codex turn failed";
    if (msg !== state._last_err) {
      state._last_err = msg;
      items.push(["error_text", stripAnsi(String(msg))]);
    }
  } else if (etype === "error") {
    const msg = d.message;
    if (msg && String(msg) !== state._last_err) {
      state._last_err = String(msg);
      items.push(["error_text", stripAnsi(String(msg))]);
    }
  }
  return items;
}

/** Dispatch one stdout line to the harness's parser via its stream format. */
export function parseHarnessLine(
  harnessId: string,
  line: string,
  state: HarnessParserState = {},
): HarnessQueueItem[] {
  const stream = HARNESS_DESCRIPTORS[harnessId]?.stream;
  switch (stream) {
    case "codex":
      return parseCodexLine(line, state);
    case "claude":
      return parseClaudeLine(line);
    case "agy":
      return parseAgyLine(line);
    default: {
      // No structured stream: raw text fallback (mirrors the Python
      // `if not stream` branch, per line instead of per chunk).
      const trimmed = line.trim();
      return trimmed ? [["chunk", stripAnsi(trimmed)]] : [];
    }
  }
}

// ---------------------------------------------------------------------------
// Unified run entry (transport dispatch)
// ---------------------------------------------------------------------------

export interface HarnessRunRequest {
  harnessId: string;
  /** Full prompt (system + user already concatenated by the caller). */
  prompt: string;
  cwd: string;
  mode: string;
  resumeId?: string | null;
  overrides: HarnessOverrides;
  signal: AbortSignal;
  /** Synchronous by contract: the caller enqueues straight into its SSE stream. */
  onItems: (items: HarnessQueueItem[]) => void;
}

export interface HarnessRunOutcome {
  /** 0 ok, 1 transport/setup failure, null unknown (e.g. killed). */
  code: number | null;
  /** Harness-native session id (reused or freshly created) for resume. */
  sessionId: string | null;
  /** Set when `code` is 1 because of a transport failure, not the model's exit. */
  error?: string;
}

/**
 * Run one harness turn. CLI harnesses spawn + parse lines; OpenCode drives the
 * OpenCode service and Pi runs embedded through its SDK. All emit the same
 * HarnessQueueItem stream, so callers don't branch on transport.
 */
export async function runHarness(req: HarnessRunRequest): Promise<HarnessRunOutcome> {
  if (req.harnessId === "pi") {
    const { runPiHarness } = await import("./pi.server");
    return runPiHarness({
      prompt: req.prompt,
      cwd: req.cwd,
      mode: req.mode,
      resumeId: req.resumeId,
      model: req.overrides[req.harnessId]?.model,
      signal: req.signal,
      onItems: req.onItems,
    });
  }
  if (isServiceTransport(req.harnessId)) {
    const { runOpencodeHarness } = await import("./opencode.server");
    return runOpencodeHarness({
      prompt: req.prompt,
      cwd: req.cwd,
      mode: req.mode,
      resumeId: req.resumeId,
      model: req.overrides[req.harnessId]?.model,
      signal: req.signal,
      onItems: req.onItems,
    });
  }
  return runCliHarness(req);
}

/** Spawn argv, line-buffer output, and map each line to queue items. */
async function runCliHarness(req: HarnessRunRequest): Promise<HarnessRunOutcome> {
  const argv = resolveHarnessArgv(
    req.harnessId,
    req.prompt,
    req.cwd,
    req.mode,
    req.resumeId,
    req.overrides,
  );
  let sessionId: string | null = null;
  const state: HarnessParserState = {};
  const result = await runHarnessSync(argv, req.cwd, {
    signal: req.signal,
    onLine: (line) => {
      const items = parseHarnessLine(req.harnessId, line, state);
      if (!items.length) return;
      for (const [qtype, qval] of items) {
        if (qtype === "session" && typeof qval === "string" && !sessionId) sessionId = qval;
      }
      req.onItems(items);
    },
  });
  return { code: result.code, sessionId };
}
