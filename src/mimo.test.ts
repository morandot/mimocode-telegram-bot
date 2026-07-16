import { describe, expect, it } from "bun:test";
import type { Config } from "./config.js";
import { extractSessionId, LineBuffer, MimoClient } from "./mimo.js";

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
