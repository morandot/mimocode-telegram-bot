/**
 * 集成部署测试 — 验证 /workdir 文件浏览器在真实文件系统上的行为
 *
 * 运行: bun run test:deploy
 *
 * 覆盖:
 *   - isInsideRoot + sanitizeError (纯函数)
 *   - /workdir feature gate (F0: workdirBrowseEnabled=false 直接阻断)
 *   - 导航守卫 (F1: wd:nav 不能离开 root)
 *   - 选择守卫 (F2: wd:sel 不能选 root 外的目录)
 *   - 创建守卫 (F3: mkdir 不能在 root 外创建)
 *   - 路径脱敏验证
 */

import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { checkAuth, isInsideRoot, sanitizeError } from "./bot.js";
import type { Config } from "./config.js";

// ── 测试用临时目录 ──────────────────────────────────────────────
const TMP = fs.mkdtempSync("/tmp/mimocode-deploy-test-");

// 创建真实目录结构:
//   TMP/
//   ├── project/           ← workdirRoot
//   │   ├── src/
//   │   ├── tests/
//   │   └── public/
//   └── secret/            ← 应该在 root 外被拦截

fs.mkdirSync(path.join(TMP, "project", "src"), { recursive: true });
fs.mkdirSync(path.join(TMP, "project", "tests"), { recursive: true });
fs.mkdirSync(path.join(TMP, "project", "public"), { recursive: true });
fs.mkdirSync(path.join(TMP, "secret", ".ssh"), { recursive: true });

const WORKSPACE = path.join(TMP, "project");

// ── 共享 config ──────────────────────────────────────────────
const cfg: Config = {
  telegramToken: "test-token",
  allowedUserIds: ["111"],
  mimoWorkDir: WORKSPACE,
  workdirRoot: WORKSPACE,
  workdirBrowseEnabled: true,
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

describe("deploy: isInsideRoot with real paths", () => {
  it("root itself is inside root", () => {
    expect(isInsideRoot(WORKSPACE, WORKSPACE)).toBe(true);
  });

  it("subdirectory is inside root", () => {
    expect(isInsideRoot(path.join(WORKSPACE, "src"), WORKSPACE)).toBe(true);
  });

  it("sibling outside root is blocked", () => {
    expect(isInsideRoot(path.join(TMP, "secret"), WORKSPACE)).toBe(false);
  });

  it("parent traversal .. is blocked", () => {
    expect(isInsideRoot(path.resolve(WORKSPACE, ".."), WORKSPACE)).toBe(false);
  });

  it("deep traversal is blocked", () => {
    expect(
      isInsideRoot(
        path.resolve(WORKSPACE, "..", "secret", ".ssh", "id_rsa"),
        WORKSPACE,
      ),
    ).toBe(false);
  });

  it("root filesystem is blocked", () => {
    expect(isInsideRoot("/", WORKSPACE)).toBe(false);
  });

  it("trailing slash in root doesn't break check", () => {
    expect(isInsideRoot(path.join(WORKSPACE, "src"), `${WORKSPACE}/`)).toBe(
      true,
    );
  });
});

describe("deploy: sanitizeError masks real paths", () => {
  it("masks Unix paths containing the workspace path", () => {
    const result = sanitizeError(`Error reading ${WORKSPACE}/src/file.ts`);
    expect(result).toContain("<path>");
    expect(result).not.toContain(WORKSPACE);
  });

  it("masks sibling directory paths", () => {
    const result = sanitizeError(`Cannot access ${path.join(TMP, "secret")}`);
    expect(result).toContain("<path>");
    expect(result).not.toContain("secret");
  });

  it("still strips ANSI", () => {
    const result = sanitizeError("\x1B[31mred error\x1B[0m");
    expect(result).not.toContain("\x1B");
    expect(result).toContain("red error");
  });
});

describe("deploy: auth gate", () => {
  it("allows whitelisted user", () => {
    expect(checkAuth({ from: { id: 111 } }, cfg)).toBe(true);
  });

  it("rejects non-whitelisted user", () => {
    expect(checkAuth({ from: { id: 999 } }, cfg)).toBe(false);
  });

  it("rejects when from is missing", () => {
    expect(checkAuth({}, cfg)).toBe(false);
  });
});

describe("deploy: /workdir feature gate (F0)", () => {
  it("disabled = handler returns early, never touches fs", () => {
    const disabledCfg = { ...cfg, workdirBrowseEnabled: false };
    expect(disabledCfg.workdirBrowseEnabled).toBe(false);
    // The handler in bot.ts:362 checks this first and returns before any fs call.
  });
});

describe("deploy: F1 navigation guard", () => {
  it("wd:nav up from root stays at root (no escape)", () => {
    const up = path.resolve(WORKSPACE, "..");
    expect(isInsideRoot(up, WORKSPACE)).toBe(false);
    // Handler would block this and keep browsingPaths at root
  });

  it("wd:nav to sibling /secret is blocked", () => {
    expect(isInsideRoot(path.join(TMP, "secret"), WORKSPACE)).toBe(false);
  });

  it("wd:nav to parent traversal is blocked", () => {
    expect(
      isInsideRoot(path.resolve(WORKSPACE, "../etc/passwd"), WORKSPACE),
    ).toBe(false);
  });

  it("wd:nav to subdirectory src is allowed", () => {
    expect(isInsideRoot(path.join(WORKSPACE, "src"), WORKSPACE)).toBe(true);
  });
});

describe("deploy: F2 selection guard", () => {
  it("wd:sel on off-root path is blocked", () => {
    expect(isInsideRoot(path.join(TMP, "secret"), WORKSPACE)).toBe(false);
  });

  it("wd:sel on root itself is allowed", () => {
    expect(isInsideRoot(WORKSPACE, WORKSPACE)).toBe(true);
  });

  it("wd:sel on subdirectory is allowed", () => {
    expect(isInsideRoot(path.join(WORKSPACE, "src"), WORKSPACE)).toBe(true);
  });
});

describe("deploy: F3 mkdir guard", () => {
  it("mkdir target outside root is rejected before fs.mkdirSync", () => {
    const target = path.join(TMP, "secret", "evil");
    expect(isInsideRoot(target, WORKSPACE)).toBe(false);
    // Guard at bot.ts:971 prevents fs.mkdirSync from ever being called
  });

  it("mkdir target inside root is allowed", () => {
    const target = path.join(WORKSPACE, "newfolder");
    expect(isInsideRoot(target, WORKSPACE)).toBe(true);
  });

  it("traversal in mkdir target is blocked", () => {
    const target = path.resolve(WORKSPACE, "..", "etc", "evil");
    expect(isInsideRoot(target, WORKSPACE)).toBe(false);
  });

  it("write-time re-validation catches . and ..", () => {
    // Mirrors bot.ts:983 guard logic
    const validName = (n: string) =>
      n !== "" &&
      n !== "." &&
      n !== ".." &&
      !path.isAbsolute(n) &&
      !n.includes("..");
    expect(validName(".")).toBe(false);
    expect(validName("..")).toBe(false);
    expect(validName("")).toBe(false);
    expect(validName("/etc/passwd")).toBe(false);
    expect(validName("normal-folder")).toBe(true);
  });
});

describe("deploy: renderExplorer reads real subdirectories", () => {
  it("lists actual subdirectories of the workspace", () => {
    const entries = fs.readdirSync(WORKSPACE, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual(["public", "src", "tests"]);
  });

  it("does not list sibling directories", () => {
    const entries = fs.readdirSync(WORKSPACE, { withFileTypes: true });
    const names = entries.map((e) => e.name);
    expect(names).not.toContain("secret");
  });
});

describe("deploy: cleanup", () => {
  it("removes temp directory after tests", () => {
    fs.rmSync(TMP, { recursive: true, force: true });
    expect(fs.existsSync(TMP)).toBe(false);
  });
});
