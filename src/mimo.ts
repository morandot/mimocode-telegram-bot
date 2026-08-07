import { type ChildProcess, spawn } from "node:child_process";
import type { Config } from "./config.js";

export type MimoResponse = {
  readonly content: string;
  readonly sessionId?: string;
};

export type SendMessageOpts = {
  model?: string;
  agent?: string;
  /** Show reasoning parts for this run regardless of MIMO_SHOW_REASONING. */
  thinking?: boolean;
  variant?: string;
  onEvent?: (event: Record<string, unknown>) => void;
};

/** A permission request that needs an interactive decision from the user. */
export type PermissionRequest = {
  readonly requestId: string;
  readonly permission: string;
  readonly patterns: readonly string[];
  readonly sessionId: string;
};

export type SessionInfo = {
  readonly id: string;
  readonly title: string;
  readonly updated: number;
};

/**
 * A run event in the same shape the old `mimo run --format json` protocol
 * used, so event rendering stays identical across the architecture change.
 */
export type RunEvent = {
  readonly type: string;
  readonly sessionID: string;
  readonly part?: Record<string, unknown>;
  readonly error?: Record<string, unknown>;
};

/** Thrown when the server answers 404 for a session-scoped request. */
export class SessionNotFoundError extends Error {
  constructor(path: string) {
    super(`Session not found: ${path}`);
    this.name = "SessionNotFoundError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "provider/model" → { providerID, modelID } for the session message API. */
export function parseModel(ref: string): {
  providerID: string;
  modelID: string;
} {
  const idx = ref.indexOf("/");
  if (idx === -1) return { providerID: ref, modelID: ref };
  return { providerID: ref.slice(0, idx), modelID: ref.slice(idx + 1) };
}

/**
 * Convert a server SSE event into the run-event shape consumed by the bot's
 * formatters. Only terminal part states are surfaced, mirroring the emit()
 * logic in MiMoCode's cli run command.
 */
export function toRunEvent(
  event: Record<string, unknown>,
): RunEvent | undefined {
  if (event.type === "message.part.updated") {
    const properties = event.properties as Record<string, unknown> | undefined;
    const part = properties?.part as Record<string, unknown> | undefined;
    if (!part) return undefined;
    const sessionID = typeof part.sessionID === "string" ? part.sessionID : "";
    const state = part.state as Record<string, unknown> | undefined;
    const time = part.time as { end?: unknown } | undefined;

    if (
      part.type === "tool" &&
      state &&
      (state.status === "completed" || state.status === "error")
    ) {
      return { type: "tool_use", sessionID, part };
    }
    if (part.type === "step-start")
      return { type: "step_start", sessionID, part };
    if (part.type === "step-finish")
      return { type: "step_finish", sessionID, part };
    if (part.type === "text" && time?.end)
      return { type: "text", sessionID, part };
    if (part.type === "reasoning" && time?.end) {
      return { type: "reasoning", sessionID, part };
    }
    return undefined;
  }
  if (event.type === "session.error") {
    const properties = event.properties as Record<string, unknown> | undefined;
    const error = properties?.error as Record<string, unknown> | undefined;
    if (!error) return undefined;
    return {
      type: "error",
      sessionID: String(properties?.sessionID ?? ""),
      error,
    };
  }
  return undefined;
}

/** Extract the session id a server event belongs to, if any. */
export function eventSessionId(
  event: Record<string, unknown>,
): string | undefined {
  const properties = event.properties as Record<string, unknown> | undefined;
  const candidates = [
    properties?.sessionID,
    (properties?.part as Record<string, unknown> | undefined)?.sessionID,
    (properties?.info as Record<string, unknown> | undefined)?.sessionID,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

/**
 * Parse an SSE byte stream into JSON events. Handles `data:` frames, multi-
 * line data fields, and non-JSON payloads (ignored).
 */
export async function* parseSse(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = parseSseFrame(frame);
      if (event) yield event;
    }
  }
  if (buffer.trim()) {
    const event = parseSseFrame(buffer);
    if (event) yield event;
  }
}

function parseSseFrame(frame: string): Record<string, unknown> | undefined {
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      data += `${line.slice(5).trimStart()}\n`;
    }
  }
  if (!data.trim()) return undefined;
  try {
    return JSON.parse(data.trim()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Manages the `mimo serve` process the bot talks to.
 *
 * When MIMO_API_URL is set the server is external and nothing is spawned;
 * otherwise the bot spawns `mimo serve` on MIMO_SERVE_PORT with the work
 * directory as cwd, waits for it to become healthy, and restarts it if it
 * dies (or when the work directory changes).
 */
export class MimoServer {
  private proc: ChildProcess | null = null;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStderr = "";
  private readonly port: number;
  private readonly cliPath: string;
  private readonly externalUrl: string | undefined;
  private workDir: string;

  constructor(config: Config) {
    this.port = config.servePort;
    this.cliPath = config.mimoCliPath;
    this.workDir = config.mimoWorkDir;
    this.externalUrl = config.mimoApiUrl;
  }

  /** True when the bot owns the serve process. */
  get isManaged(): boolean {
    return this.externalUrl === undefined;
  }

  get url(): string {
    return this.externalUrl ?? `http://127.0.0.1:${this.port}`;
  }

  get workdir(): string {
    return this.workDir;
  }

  set workdir(dir: string) {
    this.workDir = dir;
  }

  /** Start (or connect to) the server and wait until it answers health. */
  async start(): Promise<void> {
    if (!this.isManaged) {
      await this.waitForHealth(20, 500);
      return;
    }
    this.stopping = false;
    await this.spawnAndWait();
  }

  /** Stop the managed server (no-op for external servers). */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    proc.kill("SIGTERM");
    await sleep(1000);
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
    }
  }

  /** Stop and start again, picking up a new work directory. */
  async restart(): Promise<void> {
    if (!this.isManaged) return;
    await this.stop();
    this.stopping = false;
    await this.spawnAndWait();
  }

  /** Live health probe; resolves {ok, version}. */
  async health(): Promise<{ ok: boolean; version?: string }> {
    try {
      const res = await fetch(`${this.url}/global/health`);
      if (!res.ok) return { ok: false };
      const data = (await res.json()) as { version?: string };
      return { ok: true, version: data.version };
    } catch {
      return { ok: false };
    }
  }

  private async spawnAndWait(): Promise<void> {
    const proc = spawn(this.cliPath, ["serve", "--port", String(this.port)], {
      cwd: this.workDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.proc = proc;

    proc.stdout?.on("data", (c: Buffer) => {
      const line = c.toString().trim();
      if (line) console.log(`[mimo serve] ${line}`);
    });
    proc.stderr?.on("data", (c: Buffer) => {
      this.lastStderr += c.toString();
      const lines = this.lastStderr.split("\n");
      this.lastStderr = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) console.error(`[mimo serve] ${line.trim()}`);
      }
    });
    proc.on("error", (err) => {
      console.error(`[mimo serve] spawn error: ${err.message}`);
    });
    proc.on("exit", (code) => {
      if (this.proc === proc) this.proc = null;
      if (this.stopping) return;
      console.error(`[mimo serve] exited (code ${code}); restarting in 2s`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.stopping = false;
        this.spawnAndWait().catch((err) => {
          console.error(`[mimo serve] restart failed: ${err.message}`);
        });
      }, 2000);
    });

    await this.waitForHealth(60, 500);
  }

  private async waitForHealth(
    attempts: number,
    intervalMs: number,
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const health = await this.health();
      if (health.ok) return;
      await sleep(intervalMs);
    }
    const detail = this.lastStderr.trim()
      ? `: ${this.lastStderr.trim().slice(0, 300)}`
      : "";
    throw new Error(`mimo serve failed to become healthy${detail}`);
  }
}

type RunState = {
  chatId: string;
  sessionId: string;
  onEvent: (event: RunEvent) => void;
};

/**
 * HTTP client for a running `mimo serve` (or external MIMO_API_URL server).
 * Sessions map per chat, prompts are sent via the session message endpoint,
 * and a single SSE event stream feeds run rendering + permission prompts.
 */
export class MimoClient {
  private readonly server: MimoServer;
  private readonly skipPermissions: boolean;
  private readonly runTimeoutMs: number;
  private sessions = new Map<string, string>();
  private sessionChats = new Map<string, string>();
  private chatModels = new Map<string, string>();
  private chatAgents = new Map<string, string>();
  private runs = new Map<string, RunState>();
  private chatRuns = new Map<string, string>();
  /** Chats currently inside sendMessage (including session creation). */
  private runningChats = new Set<string>();
  /** Chats whose /cancel landed before their run was registered. */
  private pendingCancels = new Set<string>();
  private eventController: AbortController | null = null;
  private eventsRunning = false;
  private cachedVersion: string | undefined;

  /** Called on every permission.asked event (unless skipPermissions). */
  onPermissionRequest?: (request: PermissionRequest) => void;

  constructor(config: Config, server: MimoServer) {
    this.server = server;
    this.skipPermissions = config.skipPermissions;
    this.runTimeoutMs = config.runTimeoutMs;
  }

  // ── per-chat state ──────────────────────────────────

  getWorkDir(): string {
    return this.server.workdir;
  }

  /**
   * Switch the work directory. Restarts a managed server so the new
   * directory takes effect; the event stream reconnects automatically.
   */
  async setWorkDir(workDir: string): Promise<void> {
    this.server.workdir = workDir;
    await this.server.restart();
  }

  clearSession(chatId: string): void {
    const sessionId = this.sessions.get(chatId);
    if (sessionId) this.sessionChats.delete(sessionId);
    this.sessions.delete(chatId);
    this.chatModels.delete(chatId);
    this.chatAgents.delete(chatId);
    this.chatRuns.delete(chatId);
    this.pendingCancels.delete(chatId);
  }

  setSession(chatId: string, sessionId: string): void {
    this.sessions.set(chatId, sessionId);
    this.sessionChats.set(sessionId, chatId);
  }

  getSessionId(chatId: string): string | undefined {
    return this.sessions.get(chatId);
  }

  /** Chat that owns the given session, if any. */
  getChatIdForSession(sessionId: string): string | undefined {
    return this.sessionChats.get(sessionId);
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

  // ── server info ─────────────────────────────────────

  async ping(): Promise<boolean> {
    return (await this.server.health()).ok;
  }

  async getVersion(): Promise<string> {
    if (this.cachedVersion) return this.cachedVersion;
    const health = await this.server.health();
    if (health.version) this.cachedVersion = health.version;
    return health.version ?? "";
  }

  // ── session API ─────────────────────────────────────

  async listSessions(): Promise<SessionInfo[]> {
    const data = await this.request("/session", "GET");
    const list = Array.isArray(data) ? data : [];
    return list.map((entry: Record<string, unknown>) => {
      const time = entry.time as { updated?: unknown } | undefined;
      const rawUpdated =
        typeof time?.updated === "number"
          ? time.updated
          : typeof entry.updated === "number"
            ? entry.updated
            : 0;
      return {
        id: String(entry.id ?? ""),
        title: String(entry.title ?? ""),
        updated: rawUpdated,
      };
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionId)}`, "DELETE");
  }

  /** Create a new session server-side (public for tooling/tests). */
  async createSession(title?: string): Promise<string> {
    const body: Record<string, unknown> = {
      permission: [
        { permission: "question", action: "deny", pattern: "*" },
        { permission: "plan_exit", action: "deny", pattern: "*" },
      ],
    };
    if (title) body.title = title;
    const data = await this.request("/session", "POST", body);
    const id = (data as Record<string, unknown> | undefined)?.id;
    if (typeof id !== "string" || !id) {
      throw new Error("mimo server returned a session without an id");
    }
    return id;
  }

  async listAgents(): Promise<string[]> {
    const data = await this.request("/agent", "GET");
    if (!Array.isArray(data)) return [];
    return data
      .filter((entry) => (entry as Record<string, unknown>).mode !== "subagent")
      .map((entry) => String((entry as Record<string, unknown>).name ?? ""))
      .filter(Boolean);
  }

  // ── permission API ──────────────────────────────────

  async replyPermission(
    requestId: string,
    reply: "once" | "always" | "reject",
  ): Promise<void> {
    await this.request(
      `/permission/${encodeURIComponent(requestId)}/reply`,
      "POST",
      { reply },
    );
  }

  // ── run ─────────────────────────────────────────────

  async sendMessage(
    chatId: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<MimoResponse> {
    const sessionId = this.sessions.get(chatId);
    const model = opts?.model ?? this.chatModels.get(chatId);
    const agent = opts?.agent ?? this.chatAgents.get(chatId);

    const run = async (target: string | undefined): Promise<MimoResponse> => {
      // A /cancel may have landed while the session was being created and
      // before the run was registered; honour it instead of starting.
      if (this.pendingCancels.has(chatId)) {
        this.pendingCancels.delete(chatId);
        throw new Error("Task cancelled");
      }
      const sid = target ?? (await this.createSession(text.slice(0, 50)));
      this.setSession(chatId, sid);
      return this.promptRun(chatId, sid, text, {
        model,
        agent,
        variant: opts?.variant,
        onEvent: opts?.onEvent,
      });
    };

    // A stale bound session retries exactly once with a fresh session; a
    // second failure propagates to the caller.
    let retried = false;
    this.runningChats.add(chatId);
    try {
      try {
        return await run(sessionId);
      } catch (err) {
        if (!retried && sessionId && err instanceof SessionNotFoundError) {
          retried = true;
          console.warn(
            `[mimo] session ${sessionId} not found during run; retrying with a new session`,
          );
          this.sessions.delete(chatId);
          this.sessionChats.delete(sessionId);
          return run(undefined);
        }
        throw err;
      }
    } finally {
      this.runningChats.delete(chatId);
    }
  }

  private async promptRun(
    chatId: string,
    sessionId: string,
    text: string,
    opts: {
      model?: string;
      agent?: string;
      variant?: string;
      onEvent?: (event: Record<string, unknown>) => void;
    },
  ): Promise<MimoResponse> {
    // A /cancel may have landed between session creation and run
    // registration; honour it instead of starting.
    if (this.pendingCancels.has(chatId)) {
      this.pendingCancels.delete(chatId);
      throw new Error("Task cancelled");
    }
    let fullContent = "";
    let sseText = "";
    let runError = "";
    const state: RunState = {
      chatId,
      sessionId,
      onEvent: (event: RunEvent) => {
        // SSE text events feed real-time rendering; the authoritative
        // content comes from the prompt response parts (they are identical,
        // and the response is available even without an SSE subscription).
        if (event.type === "text") {
          const part = event.part as { text?: string } | undefined;
          if (part?.text) sseText += part.text;
        } else if (event.type === "error") {
          // Surface model/server errors (e.g. unsupported model, provider
          // 400) to the caller when there is no content to show instead of
          // silently returning an empty reply.
          const err = event.error as
            | { name?: string; message?: string; data?: { message?: string } }
            | undefined;
          const msg = err?.data?.message ?? err?.message ?? err?.name ?? "";
          if (msg) runError = runError ? `${runError}\n${msg}` : msg;
        }
        opts.onEvent?.(event as Record<string, unknown>);
      },
    };
    this.runs.set(sessionId, state);
    this.chatRuns.set(chatId, sessionId);

    const controller = new AbortController();
    let pendingError: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (this.runTimeoutMs > 0) {
      timer = setTimeout(() => {
        pendingError = new Error(
          `mimo run timed out after ${this.runTimeoutMs}ms`,
        );
        this.runs.delete(sessionId);
        this.chatRuns.delete(chatId);
        controller.abort();
        this.abortSession(sessionId).catch(() => {});
      }, this.runTimeoutMs);
    }

    const finish = () => {
      this.runs.delete(sessionId);
      if (this.chatRuns.get(chatId) === sessionId) this.chatRuns.delete(chatId);
      if (timer) clearTimeout(timer);
    };

    try {
      const body: Record<string, unknown> = {
        parts: [{ type: "text", text }],
      };
      if (opts.model) body.model = parseModel(opts.model);
      if (opts.agent) body.agent = opts.agent;
      if (opts.variant) body.variant = opts.variant;
      const response = (await this.request(
        `/session/${encodeURIComponent(sessionId)}/message`,
        "POST",
        body,
        {
          signal: controller.signal,
        },
      )) as
        | {
            info?: {
              error?: {
                name?: string;
                message?: string;
                data?: { message?: string };
              };
            };
            parts?: Array<{
              type?: string;
              text?: string;
            }>;
          }
        | undefined;
      // The server reports model/provider failures inside the response
      // message's info.error (HTTP 200) — surface them when there is no
      // content to show.
      const infoError = response?.info?.error;
      if (infoError) {
        const msg =
          infoError.data?.message ?? infoError.message ?? infoError.name ?? "";
        if (msg) runError = runError ? `${runError}\n${msg}` : msg;
      }
      // The response message carries the authoritative parts; use them for
      // the final content (falling back to SSE-accumulated text if a server
      // omits them).
      let responseHasText = false;
      if (Array.isArray(response?.parts)) {
        for (const part of response.parts) {
          if (part.type === "text" && typeof part.text === "string") {
            fullContent += part.text;
            responseHasText = true;
          }
        }
      }
      // The prompt response returns once the run completes; give the SSE
      // stream a moment to deliver the trailing parts.
      await sleep(300);
      if (!responseHasText) fullContent = sseText;
    } catch (err) {
      finish();
      if (pendingError) throw pendingError;
      throw err;
    }

    finish();
    if (pendingError) throw pendingError;
    if (!fullContent && runError) throw new Error(runError.slice(0, 500));
    if (!fullContent) {
      // serve < v0.1.10 answers 200 with an empty body for a missing
      // session instead of 404; verify the session still exists so the
      // stale-session retry in sendMessage can kick in.
      const exists = await this.sessionExists(sessionId).catch(() => true);
      if (!exists) throw new SessionNotFoundError(`/session/${sessionId}`);
    }
    return { content: fullContent, sessionId };
  }

  private async sessionExists(sessionId: string): Promise<boolean> {
    try {
      await this.request(`/session/${encodeURIComponent(sessionId)}`, "GET");
      return true;
    } catch (err) {
      if (err instanceof SessionNotFoundError) return false;
      // Any other failure (server hiccup) must not trigger a session reset.
      return true;
    }
  }

  /** Cancel the running task for a chat, if any. */
  async abort(chatId: string): Promise<boolean> {
    const sessionId = this.chatRuns.get(chatId);
    if (!sessionId) {
      // The run may not be registered yet (session creation in flight); mark
      // the chat so sendMessage aborts before prompting instead of letting
      // the task start.
      if (this.runningChats.has(chatId)) {
        this.pendingCancels.add(chatId);
        return true;
      }
      return false;
    }
    this.runs.delete(sessionId);
    this.chatRuns.delete(chatId);
    await this.abortSession(sessionId).catch(() => {});
    return true;
  }

  private async abortSession(sessionId: string): Promise<void> {
    await this.request(
      `/session/${encodeURIComponent(sessionId)}/abort`,
      "POST",
    );
  }

  // ── event stream ────────────────────────────────────

  /** Open the SSE event stream and keep it alive with backoff reconnect. */
  async startEvents(): Promise<void> {
    if (this.eventsRunning) return;
    this.eventsRunning = true;
    const controller = new AbortController();
    this.eventController = controller;
    let attempt = 0;

    while (this.eventsRunning && !controller.signal.aborted) {
      try {
        const url = `${this.server.url}/event?directory=${encodeURIComponent(this.server.workdir)}`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok || !res.body) {
          throw new Error(`event stream status ${res.status}`);
        }
        attempt = 0;
        for await (const event of parseSse(res.body)) {
          if (!this.eventsRunning) break;
          this.routeEvent(event);
        }
      } catch (err) {
        if (!this.eventsRunning) break;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[mimo] event stream error: ${message}; reconnecting`);
        const delay = Math.min(30_000, 1000 * 2 ** attempt);
        attempt++;
        await sleep(delay);
      }
    }
  }

  async stopEvents(): Promise<void> {
    this.eventsRunning = false;
    this.eventController?.abort();
    this.eventController = null;
  }

  private routeEvent(event: Record<string, unknown>): void {
    if (event.type === "permission.asked") {
      this.routePermission(event);
      return;
    }
    const runEvent = toRunEvent(event);
    if (!runEvent) return;
    const state = this.runs.get(runEvent.sessionID);
    if (!state) return;
    if (runEvent.type === "error") {
      state.onEvent(runEvent);
      return;
    }
    state.onEvent(runEvent);
  }

  private routePermission(event: Record<string, unknown>): void {
    const properties = event.properties as Record<string, unknown> | undefined;
    if (!properties) return;
    const request: PermissionRequest = {
      requestId: String(properties.id ?? ""),
      permission: String(properties.permission ?? ""),
      patterns: Array.isArray(properties.patterns)
        ? properties.patterns.map(String)
        : [],
      sessionId: String(properties.sessionID ?? ""),
    };
    if (!request.requestId) return;

    if (this.skipPermissions) {
      this.replyPermission(request.requestId, "once").catch((err) => {
        console.warn(
          `[mimo] failed to auto-approve permission: ${err.message}`,
        );
      });
      return;
    }
    this.onPermissionRequest?.(request);
  }

  // ── HTTP plumbing ───────────────────────────────────

  private async request(
    path: string,
    method: "GET" | "POST" | "DELETE",
    body?: unknown,
    init?: { signal?: AbortSignal },
  ): Promise<unknown> {
    const url = `${this.server.url}${path}${
      path.includes("?") ? "&" : "?"
    }directory=${encodeURIComponent(this.server.workdir)}`;
    const res = await fetch(url, {
      method,
      headers:
        body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: init?.signal,
    });
    if (res.status === 404) throw new SessionNotFoundError(path);
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(`mimo server error ${res.status}: ${detail}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }
}
