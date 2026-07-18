import { describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Config } from "./config.js";
import { extractSessionId, LineBuffer, MimoClient } from "./mimo.js";

const baseConfig: Config = {
  telegramToken: "test-token",
  allowedUserIds: ["111"],
  mimoWorkDir: "/tmp",
  workdirRoot: "/tmp",
  workdirBrowseEnabled: false,
  skipPermissions: false,
  runTimeoutMs: 0,
  showText: "full",
  showReasoning: "off",
  showToolUse: "off",
  showStepStart: "off",
  showStepFinish: "off",
};

// ── session management ────────────────────────────────

// ── extractSessionId ────────────────────────────────────
// Session ID extraction must stay backward compatible across MiMoCode CLI
// versions: legacy flat fields (sessionID / sessionId) and the v0.1.6+
// nested/structured forms (event.session.id, {"type":"session","id":...}).

describe("extractSessionId", () => {
  it("reads legacy flat sessionID (camelCase)", () => {
    expect(extractSessionId({ sessionID: "sess-flat-upper" })).toBe(
      "sess-flat-upper",
    );
  });

  it("reads legacy flat sessionId", () => {
    expect(extractSessionId({ sessionId: "sess-flat" })).toBe("sess-flat");
  });

  it("reads v0.1.6+ nested event.session.id", () => {
    expect(extractSessionId({ session: { id: "sess-nested" } })).toBe(
      "sess-nested",
    );
  });

  it("reads v0.1.6+ session meta line { type: session, id }", () => {
    expect(extractSessionId({ type: "session", id: "sess-meta" })).toBe(
      "sess-meta",
    );
  });

  it("reads v0.1.6+ session_start meta line", () => {
    expect(
      extractSessionId({ type: "session_start", session_id: "sess-start" }),
    ).toBe("sess-start");
  });

  it("returns undefined when no session field is present", () => {
    expect(extractSessionId({ type: "text", part: { text: "hi" } })).toBe(
      undefined,
    );
  });

  it("ignores empty / non-string values", () => {
    expect(extractSessionId({ sessionID: "" })).toBeUndefined();
    expect(extractSessionId({ sessionId: 123 })).toBeUndefined();
    expect(extractSessionId({ session: { id: 42 } })).toBeUndefined();
    expect(extractSessionId({ session: "not-an-object" })).toBeUndefined();
  });

  it("prefers legacy flat field over the nested v0.1.6 form", () => {
    // Flat field is consulted before nested, matching legacy behavior.
    expect(
      extractSessionId({ sessionID: "flat", session: { id: "nested" } }),
    ).toBe("flat");
  });

  it("sessionId (lowercase d) wins when both flat fields are present", () => {
    // Original sendMessage had two separate `if`s; the second (sessionId)
    // overwrote the first. This ordering must be preserved exactly.
    expect(extractSessionId({ sessionID: "upper", sessionId: "lower" })).toBe(
      "lower",
    );
  });
});

describe("MimoClient session management", () => {
  it("setSession / getSessionId round-trips", () => {
    const client = new MimoClient(baseConfig);
    client.setSession("chat1", "sess-abc");
    expect(client.getSessionId("chat1")).toBe("sess-abc");
  });

  it("getSessionId returns undefined for unknown chat", () => {
    const client = new MimoClient(baseConfig);
    expect(client.getSessionId("unknown")).toBeUndefined();
  });

  it("clearSession removes session, model, and agent", () => {
    const client = new MimoClient(baseConfig);
    client.setSession("chat1", "sess-abc");
    client.setModel("chat1", "gpt-4");
    client.setAgent("chat1", "plan");
    client.clearSession("chat1");
    expect(client.getSessionId("chat1")).toBeUndefined();
    expect(client.getModel("chat1")).toBeUndefined();
    expect(client.getAgent("chat1")).toBeUndefined();
  });
});

// ── model management ──────────────────────────────────

describe("MimoClient model management", () => {
  it("setModel / getModel round-trips", () => {
    const client = new MimoClient(baseConfig);
    client.setModel("chat1", "gpt-4");
    expect(client.getModel("chat1")).toBe("gpt-4");
  });

  it("getModel returns undefined when not set", () => {
    const client = new MimoClient(baseConfig);
    expect(client.getModel("chat1")).toBeUndefined();
  });
});

// ── agent management ──────────────────────────────────

describe("MimoClient agent management", () => {
  it("setAgent / getAgent round-trips", () => {
    const client = new MimoClient(baseConfig);
    client.setAgent("chat1", "compose");
    expect(client.getAgent("chat1")).toBe("compose");
  });

  it("getAgent returns undefined when not set", () => {
    const client = new MimoClient(baseConfig);
    expect(client.getAgent("chat1")).toBeUndefined();
  });
});

// ── abort ─────────────────────────────────────────────

describe("MimoClient.abort", () => {
  it("returns false when no process for chatId", () => {
    const client = new MimoClient(baseConfig);
    expect(client.abort("chat1")).toBe(false);
  });
});

// ── workdir management ────────────────────────────────

describe("MimoClient workdir management", () => {
  it("getWorkDir returns initial config workDir", () => {
    const client = new MimoClient(baseConfig);
    expect(client.getWorkDir()).toBe("/tmp");
  });

  it("setWorkDir dynamically updates the workDir", () => {
    const client = new MimoClient(baseConfig);
    client.setWorkDir("/tmp/workdir-x");
    expect(client.getWorkDir()).toBe("/tmp/workdir-x");
  });
});

// ── LineBuffer (stream reassembly) ─────────────────────
// The mimo event stream is one JSON object per line, but TCP/process chunks
// can split a line across multiple data events. LineBuffer accumulates bytes
// and only yields complete (newline-terminated) lines, so a half-line at a
// chunk boundary is never fed to JSON.parse.

describe("LineBuffer", () => {
  it("yields complete lines within a single chunk", () => {
    const buf = new LineBuffer();
    expect(buf.push('{"a":1}\n{"a":2}\n')).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("holds back a partial line split across chunks", () => {
    const buf = new LineBuffer();
    expect(buf.push('{"type":"text","part":{')).toEqual([]);
    expect(buf.push('"text":"hel')).toEqual([]);
    expect(buf.push('lo"}}\n')).toEqual([
      '{"type":"text","part":{"text":"hello"}}',
    ]);
  });

  it("flushes any trailing line without a newline", () => {
    const buf = new LineBuffer();
    buf.push("complete\n");
    buf.push('{"trailing":true}');
    expect(buf.flush()).toBe('{"trailing":true}');
    // flush is idempotent / empties the buffer
    expect(buf.flush()).toBe("");
  });

  it("ignores empty lines between events", () => {
    const buf = new LineBuffer();
    expect(buf.push('{"a":1}\n\n{"a":2}\n\n')).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("flush returns empty string when nothing buffered", () => {
    expect(new LineBuffer().flush()).toBe("");
  });
});

// ── extractSessionId ────────────────────────────────────
// Session ID extraction must stay backward compatible across MiMoCode CLI
// versions: legacy flat fields (sessionID / sessionId) and the v0.1.6+
// nested/structured forms (event.session.id, {"type":"session","id":...}).

describe("extractSessionId", () => {
  it("reads legacy flat sessionID (camelCase)", () => {
    expect(extractSessionId({ sessionID: "sess-flat-upper" })).toBe(
      "sess-flat-upper",
    );
  });

  it("reads legacy flat sessionId", () => {
    expect(extractSessionId({ sessionId: "sess-flat" })).toBe("sess-flat");
  });

  it("reads v0.1.6+ nested event.session.id", () => {
    expect(extractSessionId({ session: { id: "sess-nested" } })).toBe(
      "sess-nested",
    );
  });

  it("reads v0.1.6+ session meta line { type: session, id }", () => {
    expect(extractSessionId({ type: "session", id: "sess-meta" })).toBe(
      "sess-meta",
    );
  });

  it("reads v0.1.6+ session_start meta line", () => {
    expect(
      extractSessionId({ type: "session_start", session_id: "sess-start" }),
    ).toBe("sess-start");
  });

  it("returns undefined when no session field is present", () => {
    expect(extractSessionId({ type: "text", part: { text: "hi" } })).toBe(
      undefined,
    );
  });

  it("ignores empty / non-string values", () => {
    expect(extractSessionId({ sessionID: "" })).toBeUndefined();
    expect(extractSessionId({ sessionId: 123 })).toBeUndefined();
    expect(extractSessionId({ session: { id: 42 } })).toBeUndefined();
    expect(extractSessionId({ session: "not-an-object" })).toBeUndefined();
  });

  it("prefers legacy flat field over the nested v0.1.6 form", () => {
    // Flat field is consulted before nested, matching legacy behavior.
    expect(
      extractSessionId({ sessionID: "flat", session: { id: "nested" } }),
    ).toBe("flat");
  });

  it("sessionId (lowercase d) wins when both flat fields are present", () => {
    // Original sendMessage had two separate `if`s; the second (sessionId)
    // overwrote the first. This ordering must be preserved exactly.
    expect(extractSessionId({ sessionID: "upper", sessionId: "lower" })).toBe(
      "lower",
    );
  });
});

// ── run timeout ────────────────────────────────────────
// sendMessage must abort a hung mimo process after runTimeoutMs. We can't
// spawn the real `mimo` CLI in unit tests, so subclasses override
// spawnProcess to launch a controlled stand-in process.

// Emits one JSON text event then exits 0 — a "successful" fake mimo run.
class FakeMimoClient extends MimoClient {
  constructor(
    config: Config,
    private readonly script: string,
  ) {
    super(config);
  }
  protected override spawnProcess(_args: string[]): ChildProcess {
    return spawn("sh", ["-c", this.script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

// Long-running stand-in that never exits on its own — simulates a stall.
class HangingMimoClient extends MimoClient {
  protected override spawnProcess(_args: string[]): ChildProcess {
    return spawn("sleep", ["30"], { stdio: ["ignore", "pipe", "pipe"] });
  }
}

describe("MimoClient run timeout", () => {
  it("rejects when the run exceeds runTimeoutMs", async () => {
    const cfg: Config = { ...baseConfig, runTimeoutMs: 200 };
    const client = new HangingMimoClient(cfg);
    await expect(client.sendMessage("chat1", "hi")).rejects.toThrow(
      /timed out after 200ms/,
    );
    // Process bookkeeping must be cleaned up after a timeout.
    expect(client.abort("chat1")).toBe(false);
  });

  it("completes normally when the run finishes before runTimeoutMs", async () => {
    const cfg: Config = { ...baseConfig, runTimeoutMs: 5000 };
    // Fast fake run: emit a text event then exit 0 within ~50ms.
    const client = new FakeMimoClient(
      cfg,
      'printf \'{"type":"text","part":{"text":"hello"}}\\n\'; exit 0',
    );
    const res = await client.sendMessage("chat1", "hi");
    expect(res.content).toBe("hello");
  });

  it("disables the timeout when runTimeoutMs is 0", async () => {
    const cfg: Config = { ...baseConfig, runTimeoutMs: 0 };
    // Same fast fake run. With timeout disabled, the only way this resolves is
    // the process exiting on its own — proving no wall-clock guard fired.
    const client = new FakeMimoClient(
      cfg,
      'printf \'{"type":"text","part":{"text":"ok"}}\\n\'; exit 0',
    );
    const res = await client.sendMessage("chat1", "hi");
    expect(res.content).toBe("ok");
  });

  it("rejects promptly even when the child ignores SIGTERM", async () => {
    // A child that traps SIGTERM must not keep the promise pending until its
    // own 30s sleep ends — SIGKILL (after the grace period) must end it.
    const cfg: Config = { ...baseConfig, runTimeoutMs: 150 };
    const client = new FakeMimoClient(
      cfg,
      "trap '' TERM; echo started >&2; sleep 30",
    );
    const t0 = Date.now();
    await expect(client.sendMessage("chat1", "hi")).rejects.toThrow(
      /timed out after 150ms/,
    );
    // Rejection must happen well before the 30s sleep would end on its own.
    // (The 3s SIGKILL grace means up to ~3s is acceptable, never ~30s.)
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(client.abort("chat1")).toBe(false);
  });
});

// ── sendMessage opts forwarding ────────────────────────
// Verify the opts passed to sendMessage reach the spawned `mimo run` argv.
// We can't run the real CLI in unit tests, so a subclass overrides the now-
// protected spawnProcess to record the args and emit a fake "close" event,
// without spawning anything.

class ArgCapturingClient extends MimoClient {
  public lastArgs: string[] | null = null;

  protected override spawnProcess(args: string[]): ChildProcess {
    this.lastArgs = args;
    // A minimal fake ChildProcess that immediately "exits" 0 with no stdout,
    // so sendMessage settles without touching the real mimo binary.
    const fake = new EventEmitter() as ChildProcess;
    fake.stdout = null;
    fake.stderr = null;
    fake.kill = () => true;
    process.nextTick(() => fake.emit("close", 0));
    return fake;
  }
}

describe("MimoClient sendMessage opts forwarding", () => {
  // Run a message through the fake client; sendMessage may resolve (empty
  // content, code 0) or reject — we only care that the argv was captured.
  async function runWith(
    client: ArgCapturingClient,
    opts?: {
      thinking?: boolean;
    },
  ): Promise<string[]> {
    try {
      await client.sendMessage("chat1", "hello", opts);
    } catch {
      // expected when the fake process yields no content
    }
    // lastArgs is set synchronously inside spawnProcess during sendMessage.
    return client.lastArgs ?? [];
  }

  it("includes --thinking when opts.thinking is true", async () => {
    const client = new ArgCapturingClient(baseConfig);
    const args = await runWith(client, { thinking: true });
    expect(args).toContain("--thinking");
  });

  it("does NOT include --thinking when opts.thinking is false", async () => {
    const client = new ArgCapturingClient(baseConfig);
    const args = await runWith(client, { thinking: false });
    expect(args).not.toContain("--thinking");
  });

  it("passes the prompt text as the run argument", async () => {
    const client = new ArgCapturingClient(baseConfig);
    try {
      await client.sendMessage("chat1", "do the thing");
    } catch {
      // expected
    }
    expect(client.lastArgs?.[0]).toBe("run");
    expect(client.lastArgs?.[1]).toBe("do the thing");
  });
});
