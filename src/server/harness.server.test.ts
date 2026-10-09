// @vitest-environment node
//
// Transport split: the CLI harnesses still spawn + parse lines, while OpenCode
// is driven over @opencode/client and Pi is embedded in-process through its
// SDK (see opencode.server.test.ts and pi.server.test.ts). These tests cover
// the CLI side of runHarness plus the registry changes the split needs.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HARNESS_DESCRIPTORS,
  isServiceTransport,
  listHarnesses,
  parseHarnessLine,
  resolveHarnessArgv,
  runHarness,
} from "./harness.server";
import type { HarnessQueueItem } from "./harness.server";

/** A throwaway "harness program" that ignores argv and replays fixed stdout. */
function fakeProgram(stdout: string, exitCode = 0): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "margin-harness-"));
  const payload = join(dir, "stdout.jsonl");
  const path = join(dir, "fake-harness.sh");
  writeFileSync(payload, stdout);
  writeFileSync(path, `#!/bin/sh\ncat ${payload}\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return { path, cleanup: () => chmodSync(path, 0o644) };
}

function run(harnessId: string, executable: string, prompt = "do it") {
  const items: HarnessQueueItem[] = [];
  return {
    items,
    outcome: runHarness({
      harnessId,
      prompt,
      cwd: process.cwd(),
      mode: "edit",
      resumeId: null,
      overrides: { [harnessId]: { executable } },
      signal: new AbortController().signal,
      onItems: (i) => items.push(...i),
    }),
  };
}

describe("transport split", () => {
  it("routes opencode and pi through the in-process transports", () => {
    expect(isServiceTransport("opencode")).toBe(true);
    expect(isServiceTransport("pi")).toBe(true);
    for (const id of ["codex", "claude", "agy"]) expect(isServiceTransport(id)).toBe(false);
  });

  it("keeps the opencode descriptor free of command-line wiring", () => {
    const desc = HARNESS_DESCRIPTORS.opencode;
    expect(desc.transport).toBe("opencode");
    expect(desc.subcommand).toBeUndefined();
    expect(desc.stream).toBeUndefined();
    expect(desc.format_args).toBeUndefined();
    // Mode → agent mapping is all the transport still needs from the registry.
    expect(desc.mode_agents).toEqual({ chat: "plan", edit: "build" });
  });

  it("keeps the pi descriptor free of command-line wiring", () => {
    const desc = HARNESS_DESCRIPTORS.pi;
    expect(desc.transport).toBe("pi");
    expect(desc.subcommand).toBeUndefined();
    expect(desc.prompt_flag).toBeUndefined();
    expect(desc.stream).toBeUndefined();
    // Chat must not be able to touch the manuscript; edit gets write tools.
    expect(desc.mode_tools?.chat).not.toContain("write");
    expect(desc.mode_tools?.chat).not.toContain("edit");
    expect(desc.mode_tools?.edit).toContain("write");
  });

  it("refuses to build argv for a harness with no command line", () => {
    expect(() => resolveHarnessArgv("opencode", "hi", "/tmp")).toThrow(/no command line/);
    expect(() => resolveHarnessArgv("pi", "hi", "/tmp")).toThrow(/no command line/);
  });

  it("reports opencode availability from the service, not from PATH", async () => {
    const list = await listHarnesses({ harnesses: {} } as never);
    const oc = list.find((h) => h.id === "opencode");
    expect(oc).toBeDefined();
    expect(typeof oc?.available).toBe("boolean");
    // Models always come from the service now, so the dropdown is always live.
    expect(oc?.models_supported).toBe(true);
  });

  it("reports pi availability from the SDK, not from PATH", async () => {
    const list = await listHarnesses({ harnesses: {} } as never);
    const pi = list.find((h) => h.id === "pi");
    expect(pi).toBeDefined();
    expect(pi?.name).toBe("Pi");
    expect(typeof pi?.available).toBe("boolean");
    expect(pi?.models_supported).toBe(true);
  });
});

describe("parseHarnessLine", () => {
  it("no longer parses opencode JSON lines", () => {
    // The descriptor has no `stream`, so a JSON line is just text — the
    // opencode branch that used to unwrap `part.type` is gone.
    expect(parseHarnessLine("opencode", '{"part":{"type":"text","text":"hi"}}')).toEqual([
      ["chunk", '{"part":{"type":"text","text":"hi"}}'],
    ]);
  });

  it("still parses the CLI harnesses", () => {
    expect(
      parseHarnessLine("codex", '{"thread_id":"t1","type":"item.completed","item":{"type":"agent_message","text":"hi"}}'),
    ).toEqual([["session", "t1"], ["chunk", "hi"]]);
  });
});

describe("runHarness (cli transport)", () => {
  it("spawns the program, maps its lines, and captures the session id", async () => {
    const stdout = [
      '{"thread_id":"th_42","type":"item.completed","item":{"type":"agent_message","text":"all done"}}',
      '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":7}}',
      "",
    ].join("\n");
    const fake = fakeProgram(stdout);
    try {
      const { items, outcome } = run("codex", fake.path);
      const result = await outcome;

      expect(result.code).toBe(0);
      expect(result.sessionId).toBe("th_42");
      expect(items).toEqual([
        ["session", "th_42"],
        ["chunk", "all done"],
        ["usage", { prompt_tokens: 11, completion_tokens: 7 }],
      ]);
    } finally {
      fake.cleanup();
    }
  });

  it("passes the exit code through", async () => {
    const fake = fakeProgram('{"type":"error","message":"nope"}\n', 2);
    try {
      const { items, outcome } = run("codex", fake.path);
      const result = await outcome;
      expect(result.code).toBe(2);
      expect(items).toEqual([["error_text", "nope"]]);
    } finally {
      fake.cleanup();
    }
  });
});