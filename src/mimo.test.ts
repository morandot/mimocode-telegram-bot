import { describe, expect, it } from "bun:test";
import type { Config } from "./config.js";
import { LineBuffer, MimoClient } from "./mimo.js";

const baseConfig: Config = {
  telegramToken: "test-token",
  allowedUserIds: ["111"],
  mimoWorkDir: "/tmp",
  workdirRoot: "/tmp",
  workdirBrowseEnabled: false,
  skipPermissions: false,
  showText: "full",
  showReasoning: "off",
  showToolUse: "off",
  showStepStart: "off",
  showStepFinish: "off",
};

// ── session management ────────────────────────────────

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
