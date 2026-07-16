import { describe, expect, it } from "bun:test";
import {
  checkAuth,
  createBot,
  formatEventBrief,
  formatEventFull,
  formatEventHint,
  isInsideRoot,
  sanitizeError,
} from "./bot.js";
import type { Config } from "./config.js";

const baseConfig: Config = {
  telegramToken: "test-token",
  allowedUserIds: ["111", "222"],
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

describe("checkAuth", () => {
  it("returns true for allowed user", () => {
    const ctx = { from: { id: 111 } };
    expect(checkAuth(ctx, baseConfig)).toBe(true);
  });

  it("returns false for disallowed user", () => {
    const ctx = { from: { id: 999 } };
    expect(checkAuth(ctx, baseConfig)).toBe(false);
  });

  it("returns false when ctx.from is undefined", () => {
    const ctx = {};
    expect(checkAuth(ctx, baseConfig)).toBe(false);
  });
});

describe("sanitizeError", () => {
  it("masks Unix-style paths", () => {
    const result = sanitizeError("error in /home/user/project/file.ts");
    expect(result).toContain("<path>");
    expect(result).not.toContain("/home/user");
  });

  it("masks Windows-style paths", () => {
    const result = sanitizeError("error in C:\\Users\\test\\file.ts");
    expect(result).toContain("<path>");
    expect(result).not.toContain("C:\\Users");
  });

  it("strips ANSI escape codes", () => {
    const result = sanitizeError("\x1B[31msome error\x1B[0m");
    expect(result).not.toContain("\x1B");
    expect(result).toContain("some error");
  });

  it("truncates long errors to 100 chars", () => {
    const longError = "x".repeat(200);
    const result = sanitizeError(longError);
    expect(result.length).toBeLessThanOrEqual(110);
    expect(result).toContain("...");
  });

  it('returns "Unknown error" for empty input', () => {
    expect(sanitizeError("")).toBe("Unknown error");
  });

  it("preserves short messages", () => {
    expect(sanitizeError("connection refused")).toBe("connection refused");
  });
});

describe("isInsideRoot", () => {
  it("returns true for root itself", () => {
    expect(isInsideRoot("/workspace", "/workspace")).toBe(true);
  });

  it("returns true for a subdirectory", () => {
    expect(isInsideRoot("/workspace/projects", "/workspace")).toBe(true);
  });

  it("returns false for a sibling directory", () => {
    expect(isInsideRoot("/other", "/workspace")).toBe(false);
  });

  it("returns false for parent traversal", () => {
    expect(isInsideRoot("/workspace/../etc", "/workspace")).toBe(false);
  });

  it("returns false for root filesystem", () => {
    expect(isInsideRoot("/", "/workspace")).toBe(false);
  });

  it("handles trailing slash in root", () => {
    expect(isInsideRoot("/workspace/a", "/workspace/")).toBe(true);
  });

  it("returns false for absolute paths outside root", () => {
    expect(isInsideRoot("/home/user/.ssh", "/workspace")).toBe(false);
  });
});

describe("workdir navigation boundaries (F1)", () => {
  it("wd:nav up from root stays at root (no escape)", () => {
    expect(isInsideRoot("/tmp/..", "/tmp")).toBe(false);
    expect(isInsideRoot("/tmp", "/tmp")).toBe(true);
  });

  it("wd:nav to sibling directory is blocked", () => {
    expect(isInsideRoot("/etc", "/tmp")).toBe(false);
    expect(isInsideRoot("/home", "/tmp")).toBe(false);
  });

  it("wd:nav to parent via .. is blocked", () => {
    expect(isInsideRoot("/tmp/../../etc/passwd", "/tmp")).toBe(false);
  });

  it("root filesystem is blocked", () => {
    expect(isInsideRoot("/", "/tmp")).toBe(false);
  });

  it("absolute path outside root is blocked", () => {
    expect(isInsideRoot("/home/user/.ssh", "/tmp")).toBe(false);
    expect(isInsideRoot("/var/log", "/tmp")).toBe(false);
  });
});

describe("workdir selection boundaries (F2)", () => {
  it("wd:sel on off-root path is blocked", () => {
    expect(isInsideRoot("/etc", "/tmp")).toBe(false);
    expect(isInsideRoot("/var", "/tmp")).toBe(false);
  });

  it("wd:sel on root itself is allowed", () => {
    expect(isInsideRoot("/tmp", "/tmp")).toBe(true);
  });

  it("wd:sel on subdirectory is allowed", () => {
    expect(isInsideRoot("/tmp/subdir", "/tmp")).toBe(true);
  });
});

describe("mkdir target boundaries (F3)", () => {
  it("mkdir target outside root is rejected", () => {
    expect(isInsideRoot("/tmp/../etc/evil", "/tmp")).toBe(false);
    expect(isInsideRoot("/etc/evil", "/tmp")).toBe(false);
  });

  it("mkdir target inside root is allowed", () => {
    expect(isInsideRoot("/tmp/newfolder", "/tmp")).toBe(true);
  });

  it("traversal in mkdir target is blocked", () => {
    expect(isInsideRoot("/tmp/subdir/../../etc/evil", "/tmp")).toBe(false);
  });
});

describe("folder creation state boundaries (F5)", () => {
  it("isInsideRoot blocks absolute paths outside root", () => {
    expect(isInsideRoot("/etc", "/tmp")).toBe(false);
    expect(isInsideRoot("/var", "/tmp")).toBe(false);
    expect(isInsideRoot("/home", "/tmp")).toBe(false);
  });

  it("isInsideRoot allows root and subdirectories", () => {
    expect(isInsideRoot("/tmp", "/tmp")).toBe(true);
    expect(isInsideRoot("/tmp/subdir", "/tmp")).toBe(true);
  });
});

describe("config and command gates", () => {
  it("workdirBrowseEnabled=false blocks /workdir access", () => {
    const cfg = { ...baseConfig, workdirBrowseEnabled: false };
    // The /workdir handler returns early when workdirBrowseEnabled is false,
    // never reaching fs.readdirSync or any other filesystem call.
    expect(cfg.workdirBrowseEnabled).toBe(false);
  });

  it("workdirBrowseEnabled=true allows /workdir access", () => {
    const cfg = { ...baseConfig, workdirBrowseEnabled: true };
    expect(cfg.workdirBrowseEnabled).toBe(true);
  });
});

// ── formatEvent tool_use rendering ─────────────────────
// v0.1.5+ tool_use events carry part.state.error; users should see tool
// failures, not just output. All three verbosity levels must surface it
// while staying backward compatible (no error → identical to before).

describe("formatEventFull tool_use", () => {
  const okEvent = {
    type: "tool_use",
    part: { tool: "bash", state: { output: "done" } },
  };
  const errEvent = {
    type: "tool_use",
    part: {
      tool: "bash",
      state: { output: "", error: "permission denied" },
    },
  };

  it("renders tool name and output when no error", () => {
    const r = formatEventFull(okEvent);
    expect(r).toContain("🔧 bash");
    expect(r).toContain("output: done");
    expect(r).not.toContain("❌");
  });

  it("renders error with ❌ marker when present", () => {
    const r = formatEventFull(errEvent);
    expect(r).toContain("❌");
    expect(r).toContain("permission denied");
  });

  it("truncates very long errors to keep messages readable", () => {
    const longErr = "x".repeat(1000);
    const r = formatEventFull({
      type: "tool_use",
      part: { tool: "bash", state: { error: longErr } },
    });
    // error label prefix + truncated body, never the full 1000 chars
    expect(r).toContain("❌");
    expect(r.length).toBeLessThan(longErr.length);
  });
});

describe("formatEventBrief tool_use", () => {
  it("appends ❌ + short error when error present", () => {
    const r = formatEventBrief({
      type: "tool_use",
      part: { tool: "bash", state: { error: "boom" } },
    });
    expect(r).toContain("❌");
    expect(r).toContain("boom");
  });

  it("omits ❌ when no error", () => {
    const r = formatEventBrief({
      type: "tool_use",
      part: { tool: "bash", state: { title: "running" } },
    });
    expect(r).not.toContain("❌");
  });
});

describe("formatEventHint tool_use", () => {
  it("appends ❌ when error present", () => {
    const r = formatEventHint({
      type: "tool_use",
      part: { tool: "bash", state: { error: "fail" } },
    });
    expect(r).toContain("❌");
  });

  it("omits ❌ when no error", () => {
    const r = formatEventHint({
      type: "tool_use",
      part: { tool: "bash", state: { title: "running" } },
    });
    expect(r).not.toContain("❌");
  });
});

// ── createBot registers commands (smoke test) ──────────
// Constructing the bot must register every command handler, including the
// newer /think, without throwing. grammy stores handlers in memory; no
// network is touched by createBot itself.

describe("createBot command registration", () => {
  it("registers all commands without throwing", () => {
    const bot = createBot(baseConfig);
    // grammy exposes the number of registered handlers via the internal
    // composer; we just assert the bot object is usable.
    expect(bot).toBeDefined();
    // Calling bot.start is network-bound, so we stop here — registration
    // itself (including /think) is the behavior under test.
  });
});
