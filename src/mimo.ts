import { type ChildProcess, spawn } from "node:child_process";
import type { Config } from "./config.js";

export type MimoResponse = {
  readonly content: string;
  readonly sessionId?: string;
};

export type SendMessageOpts = {
  model?: string;
  agent?: string;
  thinking?: boolean;
  variant?: string;
  onEvent?: (event: Record<string, unknown>) => void;
};

/**
 * Accumulates a byte stream and yields complete, newline-terminated lines.
 *
 * Process/TCP `data` events can split a single JSON line across chunks (or
 * glue several together). `push` only returns whole lines, holding any
 * trailing partial line back until more data arrives or `flush` is called.
 */
export class LineBuffer {
  private pending = "";

  /** Append a chunk; return the complete lines now available. */
  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split("\n");
    // The last element is either "" (chunk ended on \n) or a partial line.
    this.pending = parts.pop() ?? "";
    const lines: string[] = [];
    for (const line of parts) {
      if (line) lines.push(line);
    }
    return lines;
  }

  /** Return any buffered partial line (no trailing newline), then clear. */
  flush(): string {
    const rest = this.pending;
    this.pending = "";
    return rest;
  }
}

/**
 * Extract a session id from a MiMoCode stream event across CLI versions.
 *
 * Legacy formats (pre-v0.1.6) carry the id as a flat top-level string:
 *   `event.sessionID` / `event.sessionId`.
 *
 * v0.1.6+ may nest it (`event.session.id`) or emit it as a structured
 * meta line (`{ type: "session" | "session_start", id | session_id }`).
 *
 * The two legacy flat fields mirror the original sendMessage behavior exactly:
 * both are checked and `sessionId` wins when both are present (it was the
 * second `if` that overwrote the result). Newer formats are only consulted
 * when no legacy id was found. Returns undefined when none are present.
 */
export function extractSessionId(
  event: Record<string, unknown>,
): string | undefined {
  // Legacy flat fields — accumulate (not early-return) so the original
  // two-`if` overwrite semantics are preserved: sessionId wins over sessionID.
  let id: string | undefined;
  if (typeof event.sessionID === "string" && event.sessionID) {
    id = event.sessionID;
  }
  if (typeof event.sessionId === "string" && event.sessionId) {
    id = event.sessionId;
  }
  if (id) return id;

  // v0.1.6+: nested session object.
  const session = event.session;
  if (session && typeof session === "object") {
    const nestedId = (session as Record<string, unknown>).id;
    if (typeof nestedId === "string" && nestedId) return nestedId;
  }

  // v0.1.6+: structured meta line { type: "session", id }.
  if (event.type === "session" && typeof event.id === "string" && event.id) {
    return event.id;
  }

  // v0.1.6+: session_start meta line.
  if (
    event.type === "session_start" &&
    typeof event.session_id === "string" &&
    event.session_id
  ) {
    return event.session_id;
  }

  return undefined;
}

export class MimoClient {
  private workDir: string;
  private readonly mimoCliPath: string;
  private readonly mimoApiUrl?: string;
  private readonly skipPermissions: boolean;
  protected readonly runTimeoutMs: number;
  private sessions: Map<string, string> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private chatModels: Map<string, string> = new Map();
  private chatAgents: Map<string, string> = new Map();
  private cachedVersion: string | undefined;

  constructor(config: Config) {
    this.workDir = config.mimoWorkDir;
    this.mimoCliPath = config.mimoCliPath;
    this.mimoApiUrl = config.mimoApiUrl;
    this.skipPermissions = config.skipPermissions;
    this.runTimeoutMs = config.runTimeoutMs;
  }

  getWorkDir(): string {
    return this.workDir;
  }

  setWorkDir(workDir: string): void {
    this.workDir = workDir;
  }

  clearSession(chatId: string): void {
    this.sessions.delete(chatId);
    this.chatModels.delete(chatId);
    this.chatAgents.delete(chatId);
  }

  setSession(chatId: string, sessionId: string): void {
    this.sessions.set(chatId, sessionId);
  }

  getSessionId(chatId: string): string | undefined {
    return this.sessions.get(chatId);
  }

  getModel(chatId: string): string | undefined {
    return this.chatModels.get(chatId);
  }

  setModel(chatId: string, model: string): void {
    this.chatModels.set(chatId, model);
  }

  getAgent(chatId: string): string | undefined {
    return this.chatAgents.get(chatId);
  }

  setAgent(chatId: string, agent: string): void {
    this.chatAgents.set(chatId, agent);
  }

  abort(chatId: string): boolean {
    const proc = this.processes.get(chatId);
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
      this.processes.delete(chatId);
      return true;
    }
    this.processes.delete(chatId);
    return false;
  }

  protected spawnProcess(args: string[]): ChildProcess {
    return spawn(this.mimoCliPath, args, {
      cwd: this.workDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  }

  private spawnStreaming(
    args: string[],
    chatId: string,
    onStdout: (chunk: Buffer) => void,
    opts?: { timeoutMs?: number },
  ): Promise<{ stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const proc = this.spawnProcess(args);
      this.processes.set(chatId, proc);

      let stderr = "";
      let settled = false;
      let termTimer: ReturnType<typeof setTimeout> | undefined;

      // Cancel the pending timeout. The post-timeout SIGKILL grace timer is
      // intentionally NOT cleared here: if SIGTERM fails to stop the process,
      // the grace timer must still fire SIGKILL. It is unref'd so it never
      // keeps the process alive on its own.
      const cancelTimeout = () => {
        if (termTimer) clearTimeout(termTimer);
        termTimer = undefined;
      };

      // Wall-clock timeout. Two-stage: SIGTERM first, SIGKILL after a grace
      // period. We reject immediately on timeout rather than waiting for the
      // `close` event, because mimo often spawns children that inherit the
      // stdio pipes — a grandchild holding the pipe can delay `close` long
      // after the main process is dead.
      const timeoutMs = opts?.timeoutMs ?? 0;
      if (timeoutMs > 0) {
        termTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          proc.kill("SIGTERM");
          // Force-kill if the process has NOT actually exited after the grace
          // period. Use exitCode/signalCode (null until exit) rather than
          // proc.killed — the latter flips true as soon as the signal is sent,
          // whether or not the child honored it, which would skip SIGKILL for
          // a process that ignores SIGTERM.
          const killTimer = setTimeout(() => {
            if (proc.exitCode === null && proc.signalCode === null) {
              proc.kill("SIGKILL");
            }
          }, 3000);
          killTimer.unref?.();
          cancelTimeout();
          this.processes.delete(chatId);
          reject(new Error(`mimo run timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        termTimer.unref?.();
      }

      proc.stdout?.on("data", onStdout);
      proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        this.processes.delete(chatId);
        resolve({ stderr, code: code ?? -1 });
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        this.processes.delete(chatId);
        reject(new Error(`Failed to spawn mimo: ${err.message}`));
      });
    });
  }

  async exec(
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const proc = this.spawnProcess(args);

      let stdout = "";
      let stderr = "";
      const timeout = opts?.timeoutMs ?? 30_000;

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`mimo ${args[0]} timed out (${timeout}ms)`));
      }, timeout);

      proc.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
      proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? -1 });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ stdout: "", stderr: err.message, code: -1 });
      });
    });
  }

  async ping(): Promise<boolean> {
    const r = await this.exec(["--version"], { timeoutMs: 5000 });
    return r.code === 0;
  }

  async getVersion(): Promise<string> {
    if (this.cachedVersion) return this.cachedVersion;
    const r = await this.exec(["--version"], { timeoutMs: 5000 });
    const version = r.stdout.trim();
    if (version) this.cachedVersion = version;
    return version;
  }

  async sendMessage(
    chatId: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<MimoResponse> {
    const sessionId = this.sessions.get(chatId);
    const model = opts?.model ?? this.chatModels.get(chatId);
    const agent = opts?.agent ?? this.chatAgents.get(chatId);

    const runMimo = async (sessionToUse?: string): Promise<MimoResponse> => {
      const args = ["run", text, "--format", "json"];
      if (this.skipPermissions) {
        args.push("--dangerously-skip-permissions");
      }
      if (this.mimoApiUrl) {
        args.push("--attach", this.mimoApiUrl, "--dir", this.workDir);
      }
      if (sessionToUse) {
        args.push("--session", sessionToUse);
      }
      if (model) {
        args.push("--model", model);
      }
      if (agent) {
        args.push("--agent", agent);
      }
      if (opts?.thinking) {
        args.push("--thinking");
      }
      if (opts?.variant) {
        args.push("--variant", opts.variant);
      }

      let fullContent = "";
      let newSessionId = sessionToUse ?? "";

      const lineBuffer = new LineBuffer();
      const handleLine = (line: string) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (opts?.onEvent) opts.onEvent(event);
          if (event.type === "text") {
            const part = event.part as { text?: string } | undefined;
            if (part?.text) {
              fullContent += part.text;
            }
          }
          const sid = extractSessionId(event);
          if (sid) {
            newSessionId = sid;
          }
        } catch {
          // skip non-JSON lines (debug output mixed into stdout, etc.)
        }
      };

      const { stderr, code } = await this.spawnStreaming(
        args,
        chatId,
        (chunk: Buffer) => {
          for (const line of lineBuffer.push(chunk.toString())) {
            handleLine(line);
          }
        },
        { timeoutMs: this.runTimeoutMs },
      );

      // Flush a final event emitted without a trailing newline.
      const tail = lineBuffer.flush();
      if (tail) handleLine(tail);

      if (code !== 0 && !fullContent) {
        throw new Error(
          `mimo run failed (code ${code}): ${stderr.slice(0, 200)}`,
        );
      }
      // mimo CLI exits 0 even when it logs a "Session not found" error to stderr.
      // Treat that as a stale-session failure so the caller can retry.
      if (fullContent === "" && /Session not found/.test(stderr)) {
        throw new Error(
          `mimo run failed: Session not found: ${stderr.slice(0, 200)}`,
        );
      }
      if (newSessionId) {
        this.sessions.set(chatId, newSessionId);
      }
      return { content: fullContent, sessionId: newSessionId };
    };

    try {
      return await runMimo(sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const clean = msg.replace(/\x1b\[[0-9;]*m/g, "");
      if (sessionId && clean.includes("Session not found")) {
        console.warn(
          `[mimo] session ${sessionId} not found during run; retrying with a new session`,
        );
        this.sessions.delete(chatId);
        return runMimo();
      }
      throw err;
    }
  }
}
