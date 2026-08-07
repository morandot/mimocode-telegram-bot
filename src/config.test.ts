import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "./config.js";
import { env, envBool, isAllowed, loadConfig } from "./config.js";

// ── env helper ──────────────────────────────────────────

describe("env", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns env var when set", () => {
    process.env.TEST_KEY = "hello";
    expect(env("TEST_KEY")).toBe("hello");
  });

  it("returns fallback when env var is missing", () => {
    delete process.env.TEST_KEY;
    expect(env("TEST_KEY", "default")).toBe("default");
  });

  it("throws when env var is missing and no fallback", () => {
    delete process.env.TEST_KEY;
    expect(() => env("TEST_KEY")).toThrow("Missing env: TEST_KEY");
  });
});

// ── envBool helper ──────────────────────────────────────

describe("envBool", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns true for 'true'", () => {
    process.env.MY_BOOL = "true";
    expect(envBool("MY_BOOL", false)).toBe(true);
  });

  it("returns true for '1'", () => {
    process.env.MY_BOOL = "1";
    expect(envBool("MY_BOOL", false)).toBe(true);
  });

  it("returns false for '0'", () => {
    process.env.MY_BOOL = "0";
    expect(envBool("MY_BOOL", true)).toBe(false);
  });

  it("returns false for 'false'", () => {
    process.env.MY_BOOL = "false";
    expect(envBool("MY_BOOL", true)).toBe(false);
  });

  it("returns fallback when env var is unset", () => {
    delete process.env.MY_BOOL;
    expect(envBool("MY_BOOL", true)).toBe(true);
    expect(envBool("MY_BOOL", false)).toBe(false);
  });
});

// ── isAllowed ───────────────────────────────────────────

describe("isAllowed", () => {
  const baseConfig: Config = {
    telegramToken: "test-token",
    allowedUserIds: ["111", "222"],
    mimoWorkDir: "/tmp",
    workdirRoot: "/tmp",
    workdirBrowseEnabled: false,
    skipPermissions: false,
    servePort: 4096,
    mimoCliPath: "mimo",
    runTimeoutMs: 0,
    showText: "full",
    showReasoning: "off",
    showToolUse: "off",
    showStepStart: "off",
    showStepFinish: "off",
  };

  it("returns true for valid user ID", () => {
    expect(isAllowed("111", baseConfig)).toBe(true);
  });

  it("returns false for invalid user ID", () => {
    expect(isAllowed("999", baseConfig)).toBe(false);
  });

  it("returns false when allowedUserIds is empty", () => {
    const emptyConfig: Config = { ...baseConfig, allowedUserIds: [] };
    expect(isAllowed("anyone", emptyConfig)).toBe(false);
  });
});

// ── loadConfig ──────────────────────────────────────────

describe("loadConfig", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      TELEGRAM_BOT_TOKEN: "test-token-123",
      TELEGRAM_ALLOWED_USER_ID: "111, 222",
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("returns correct Config with valid env vars", () => {
    const config = loadConfig();
    expect(config.telegramToken).toBe("test-token-123");
    expect(config.allowedUserIds).toEqual(["111", "222"]);
    expect(config.skipPermissions).toBe(false);
  });

  it("throws when TELEGRAM_BOT_TOKEN is missing", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(() => loadConfig()).toThrow("Missing env: TELEGRAM_BOT_TOKEN");
  });

  it("throws when TELEGRAM_ALLOWED_USER_ID is empty", () => {
    process.env.TELEGRAM_ALLOWED_USER_ID = "";
    expect(() => loadConfig()).toThrow("TELEGRAM_ALLOWED_USER_ID is empty");
  });

  it("parses multiple comma-separated user IDs", () => {
    process.env.TELEGRAM_ALLOWED_USER_ID = "100,200,300";
    const config = loadConfig();
    expect(config.allowedUserIds).toEqual(["100", "200", "300"]);
  });

  it("trims whitespace around user IDs", () => {
    process.env.TELEGRAM_ALLOWED_USER_ID = " 100 , 200 ";
    const config = loadConfig();
    expect(config.allowedUserIds).toEqual(["100", "200"]);
  });

  it("sets skipPermissions to true when MIMO_SKIP_PERMISSIONS=true", () => {
    process.env.MIMO_SKIP_PERMISSIONS = "true";
    const config = loadConfig();
    expect(config.skipPermissions).toBe(true);
  });

  it("sets skipPermissions to true when MIMO_SKIP_PERMISSIONS=1", () => {
    process.env.MIMO_SKIP_PERMISSIONS = "1";
    const config = loadConfig();
    expect(config.skipPermissions).toBe(true);
  });

  it("sets skipPermissions to false when MIMO_SKIP_PERMISSIONS=0", () => {
    process.env.MIMO_SKIP_PERMISSIONS = "0";
    const config = loadConfig();
    expect(config.skipPermissions).toBe(false);
  });

  it("sets mimoApiUrl to undefined when not set", () => {
    delete process.env.MIMO_API_URL;
    const config = loadConfig();
    expect(config.mimoApiUrl).toBeUndefined();
  });

  it("sets mimoApiUrl when MIMO_API_URL is set", () => {
    process.env.MIMO_API_URL = "http://localhost:3000";
    const config = loadConfig();
    expect(config.mimoApiUrl).toBe("http://localhost:3000");
  });

  it("defaults runTimeoutMs to 300000 (5 min)", () => {
    delete process.env.MIMO_RUN_TIMEOUT_MS;
    const config = loadConfig();
    expect(config.runTimeoutMs).toBe(300_000);
  });

  it("defaults servePort to 4096", () => {
    delete process.env.MIMO_SERVE_PORT;
    const config = loadConfig();
    expect(config.servePort).toBe(4096);
  });

  it("parses MIMO_SERVE_PORT", () => {
    process.env.MIMO_SERVE_PORT = "8080";
    const config = loadConfig();
    expect(config.servePort).toBe(8080);
  });

  it("treats whitespace-only MIMO_SERVE_PORT as unset (default)", () => {
    process.env.MIMO_SERVE_PORT = "   ";
    const config = loadConfig();
    expect(config.servePort).toBe(4096);
  });

  it("rejects non-numeric MIMO_SERVE_PORT", () => {
    process.env.MIMO_SERVE_PORT = "abc";
    expect(() => loadConfig()).toThrow("MIMO_SERVE_PORT");
  });

  it("rejects out-of-range MIMO_SERVE_PORT", () => {
    process.env.MIMO_SERVE_PORT = "70000";
    expect(() => loadConfig()).toThrow("MIMO_SERVE_PORT");
    process.env.MIMO_SERVE_PORT = "0";
    expect(() => loadConfig()).toThrow("MIMO_SERVE_PORT");
  });

  it("parses MIMO_RUN_TIMEOUT_MS as milliseconds", () => {
    process.env.MIMO_RUN_TIMEOUT_MS = "600000";
    const config = loadConfig();
    expect(config.runTimeoutMs).toBe(600_000);
  });

  it("0 means no timeout (unlimited)", () => {
    process.env.MIMO_RUN_TIMEOUT_MS = "0";
    const config = loadConfig();
    expect(config.runTimeoutMs).toBe(0);
  });

  it("rejects non-numeric MIMO_RUN_TIMEOUT_MS", () => {
    process.env.MIMO_RUN_TIMEOUT_MS = "abc";
    expect(() => loadConfig()).toThrow("MIMO_RUN_TIMEOUT_MS");
  });

  it("rejects negative MIMO_RUN_TIMEOUT_MS", () => {
    process.env.MIMO_RUN_TIMEOUT_MS = "-1";
    expect(() => loadConfig()).toThrow("MIMO_RUN_TIMEOUT_MS");
  });

  it("treats whitespace-only MIMO_RUN_TIMEOUT_MS as unset (default)", () => {
    process.env.MIMO_RUN_TIMEOUT_MS = "   ";
    const config = loadConfig();
    expect(config.runTimeoutMs).toBe(300_000);
  });

  it("treats empty-string MIMO_RUN_TIMEOUT_MS as unset (default)", () => {
    process.env.MIMO_RUN_TIMEOUT_MS = "";
    const config = loadConfig();
    expect(config.runTimeoutMs).toBe(300_000);
  });

  it("rejects fractional MIMO_RUN_TIMEOUT_MS (must be integer ms)", () => {
    process.env.MIMO_RUN_TIMEOUT_MS = "1.5";
    expect(() => loadConfig()).toThrow("MIMO_RUN_TIMEOUT_MS");
  });

  it("trims surrounding whitespace from MIMO_RUN_TIMEOUT_MS", () => {
    process.env.MIMO_RUN_TIMEOUT_MS = "  600000  ";
    const config = loadConfig();
    expect(config.runTimeoutMs).toBe(600_000);
  });
});
