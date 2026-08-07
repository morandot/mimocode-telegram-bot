import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Config } from "./config.js";
import {
  eventSessionId,
  MimoClient,
  MimoServer,
  parseModel,
  parseSse,
  SessionNotFoundError,
  toRunEvent,
} from "./mimo.js";

const baseConfig: Config = {
  telegramToken: "test-token",
  allowedUserIds: ["111"],
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

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * A fake `mimo serve` speaking the real HTTP surface: session CRUD, the
 * message endpoint, permission replies, agent listing, health, and an SSE
 * /event stream the test can push events into.
 */
class FakeMimoServer {
  server: Server;
  port = 0;
  sessions = new Map<string, { title: string }>();
  promptBodies: Array<Record<string, unknown>> = [];
  permissionReplies: Array<{ id: string; reply: unknown }> = [];
  aborted: string[] = [];
  deleted: string[] = [];
  sseConnections = 0;
  /** Parts returned by a successful message response. */
  responseParts: Array<Record<string, unknown>> = [];
  messageBehavior: "resolve" | "hang" | "404" | "model-error" | "stale-200" =
    "resolve";
  /** When true, GET /session/{id} answers 404 for ids not in the store. */
  strictSessionGet = false;
  /** Artificial delay (ms) before a POST /session responds. */
  createDelayMs = 0;
  sessionCreates = 0;
  private sseResponses: ServerResponse[] = [];
  private seq = 0;

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async listen(): Promise<number> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (address === null || typeof address === "string") return 4096;
    return address.port;
  }

  async close(): Promise<void> {
    for (const res of this.sseResponses) res.end();
    this.sseResponses = [];
    this.server.close();
  }

  /** Push an event to every connected /event stream. */
  pushEvent(event: Record<string, unknown>): void {
    for (const res of this.sseResponses) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/global/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "0.1.10" }));
      return;
    }

    if (method === "GET" && url.pathname === "/event") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      this.sseConnections++;
      this.sseResponses.push(res);
      req.on("close", () => {
        this.sseResponses = this.sseResponses.filter((r) => r !== res);
      });
      return;
    }

    if (method === "POST" && url.pathname === "/session") {
      this.sessionCreates++;
      if (this.createDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
      }
      const body = await readJson(req);
      const id = `sess-${++this.seq}`;
      this.sessions.set(id, { title: String(body.title ?? "") });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id }));
      return;
    }

    if (method === "GET" && url.pathname === "/session") {
      const list = [...this.sessions.entries()].map(([id, s]) => ({
        id,
        title: s.title,
        time: { created: 1, updated: 2 },
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    if (
      method === "GET" &&
      url.pathname.startsWith("/session/") &&
      this.strictSessionGet
    ) {
      const id = url.pathname.slice("/session/".length);
      if (!this.sessions.has(id)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ id, title: this.sessions.get(id)?.title ?? "" }),
      );
      return;
    }

    if (method === "DELETE" && url.pathname.startsWith("/session/")) {
      const id = url.pathname.slice("/session/".length);
      this.deleted.push(id);
      this.sessions.delete(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }

    if (
      method === "POST" &&
      url.pathname.startsWith("/session/") &&
      url.pathname.endsWith("/message")
    ) {
      const body = await readJson(req);
      this.promptBodies.push(body);
      if (this.messageBehavior === "404") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      if (this.messageBehavior === "hang") return;
      if (this.messageBehavior === "model-error") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            info: {
              error: {
                name: "APIError",
                data: { message: "Unsupported model mimo-auto" },
              },
            },
          }),
        );
        return;
      }
      if (this.messageBehavior === "stale-200") {
        // serve < v0.1.10 answers 200 + empty body for missing sessions.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          parts: this.responseParts,
        }),
      );
      return;
    }

    if (
      method === "POST" &&
      url.pathname.startsWith("/session/") &&
      url.pathname.endsWith("/abort")
    ) {
      const id = url.pathname.slice("/session/".length, -"/abort".length);
      this.aborted.push(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(true));
      return;
    }

    if (
      method === "POST" &&
      url.pathname.startsWith("/permission/") &&
      url.pathname.endsWith("/reply")
    ) {
      const id = url.pathname.slice("/permission/".length, -"/reply".length);
      const body = await readJson(req);
      this.permissionReplies.push({ id, reply: body.reply });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }

    if (method === "GET" && url.pathname === "/agent") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          { name: "build", mode: "primary" },
          { name: "plan", mode: "primary" },
          { name: "explorer", mode: "subagent" },
        ]),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let fake: FakeMimoServer | undefined;

function makeClient(
  config: Config,
  port: number,
): { server: MimoServer; client: MimoClient } {
  const server = new MimoServer({ ...config, servePort: port });
  const client = new MimoClient({ ...config, servePort: port }, server);
  return { server, client };
}

beforeEach(async () => {
  fake = new FakeMimoServer();
  const port = await fake.listen();
  fake.port = port;
});

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** Non-null accessor for the per-test fake server. */
function f(): FakeMimoServer {
  if (fake === undefined) throw new Error("fake server not initialized");
  return fake;
}

// ── parseModel ────────────────────────────────────────

describe("parseModel", () => {
  it("splits provider/model", () => {
    expect(parseModel("deepseek/deepseek-v4")).toEqual({
      providerID: "deepseek",
      modelID: "deepseek-v4",
    });
  });

  it("keeps the whole string when no slash", () => {
    expect(parseModel("mimo-auto")).toEqual({
      providerID: "mimo-auto",
      modelID: "mimo-auto",
    });
  });
});

// ── toRunEvent ────────────────────────────────────────

describe("toRunEvent", () => {
  const part = (overrides: Record<string, unknown>) => ({
    sessionID: "sess-1",
    ...overrides,
  });

  it("maps completed tool parts to tool_use", () => {
    const event = {
      type: "message.part.updated",
      properties: {
        part: part({
          type: "tool",
          tool: "bash",
          state: { status: "completed", output: "ok" },
        }),
      },
    };
    expect(toRunEvent(event)?.type).toBe("tool_use");
    expect(toRunEvent(event)?.part).toEqual(event.properties.part);
  });

  it("maps errored tool parts to tool_use with error", () => {
    const event = {
      type: "message.part.updated",
      properties: {
        part: part({
          type: "tool",
          tool: "bash",
          state: { status: "error", error: "boom" },
        }),
      },
    };
    expect(toRunEvent(event)?.type).toBe("tool_use");
  });

  it("ignores running tool parts", () => {
    const event = {
      type: "message.part.updated",
      properties: {
        part: part({
          type: "tool",
          tool: "bash",
          state: { status: "running" },
        }),
      },
    };
    expect(toRunEvent(event)).toBeUndefined();
  });

  it("maps step-start and step-finish", () => {
    expect(
      toRunEvent({
        type: "message.part.updated",
        properties: { part: part({ type: "step-start" }) },
      })?.type,
    ).toBe("step_start");
    expect(
      toRunEvent({
        type: "message.part.updated",
        properties: {
          part: part({ type: "step-finish", tokens: { total: 1 } }),
        },
      })?.type,
    ).toBe("step_finish");
  });

  it("maps finished text parts, ignores streaming ones", () => {
    const done = {
      type: "message.part.updated",
      properties: {
        part: part({ type: "text", text: "hi", time: { end: 5 } }),
      },
    };
    expect(toRunEvent(done)?.type).toBe("text");
    const streaming = {
      type: "message.part.updated",
      properties: { part: part({ type: "text", text: "hi" }) },
    };
    expect(toRunEvent(streaming)).toBeUndefined();
  });

  it("maps finished reasoning parts", () => {
    const event = {
      type: "message.part.updated",
      properties: {
        part: part({ type: "reasoning", text: "hmm", time: { end: 5 } }),
      },
    };
    expect(toRunEvent(event)?.type).toBe("reasoning");
  });

  it("maps session.error to error", () => {
    const event = {
      type: "session.error",
      properties: {
        sessionID: "sess-1",
        error: { name: "Error", data: { message: "provider 400" } },
      },
    };
    const converted = toRunEvent(event);
    expect(converted?.type).toBe("error");
    expect(converted?.sessionID).toBe("sess-1");
    expect(converted?.error).toEqual(event.properties.error);
  });

  it("returns undefined for unrelated events", () => {
    expect(
      toRunEvent({ type: "message.updated", properties: { info: {} } }),
    ).toBeUndefined();
    expect(
      toRunEvent({ type: "permission.asked", properties: {} }),
    ).toBeUndefined();
  });
});

// ── eventSessionId ────────────────────────────────────

describe("eventSessionId", () => {
  it("reads sessionID from properties", () => {
    expect(eventSessionId({ type: "x", properties: { sessionID: "s1" } })).toBe(
      "s1",
    );
  });

  it("reads sessionID from the part", () => {
    expect(
      eventSessionId({ type: "x", properties: { part: { sessionID: "s2" } } }),
    ).toBe("s2");
  });

  it("reads sessionID from info", () => {
    expect(
      eventSessionId({ type: "x", properties: { info: { sessionID: "s3" } } }),
    ).toBe("s3");
  });

  it("returns undefined when absent", () => {
    expect(eventSessionId({ type: "x", properties: {} })).toBeUndefined();
  });
});

// ── parseSse ──────────────────────────────────────────

describe("parseSse", () => {
  async function collect(
    chunks: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const events: Array<Record<string, unknown>> = [];
    const stream = (async function* () {
      for (const chunk of chunks) yield new TextEncoder().encode(chunk);
    })();
    for await (const event of parseSse(stream)) events.push(event);
    return events;
  }

  it("parses data frames split across chunks", async () => {
    const events = await collect(['data: {"a":', '1}\n\ndata: {"b":2}\n\n']);
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles a trailing frame without newline", async () => {
    const events = await collect(['data: {"a":1}\n\ndata: {"b":2}']);
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("ignores non-JSON data lines", async () => {
    const events = await collect(['data: not-json\n\ndata: {"a":1}\n\n']);
    expect(events).toEqual([{ a: 1 }]);
  });

  it("joins multi-line data fields", async () => {
    const events = await collect(['data: {"a":1,\ndata: "b":2}\n\n']);
    expect(events).toEqual([{ a: 1, b: 2 }]);
  });
});

// ── MimoServer (no spawn) ─────────────────────────────

describe("MimoServer", () => {
  it("is managed and uses the configured port by default", () => {
    const server = new MimoServer(baseConfig);
    expect(server.isManaged).toBe(true);
    expect(server.url).toBe("http://127.0.0.1:4096");
  });

  it("connects to an external server when MIMO_API_URL is set", () => {
    const config: Config = {
      ...baseConfig,
      mimoApiUrl: "http://127.0.0.1:9999",
    };
    const server = new MimoServer(config);
    expect(server.isManaged).toBe(false);
    expect(server.url).toBe("http://127.0.0.1:9999");
  });

  it("exposes the work directory", () => {
    const server = new MimoServer(baseConfig);
    server.workdir = "/srv/project";
    expect(server.workdir).toBe("/srv/project");
  });

  it("health probes the server", async () => {
    const port = f().port;
    const server = new MimoServer({ ...baseConfig, servePort: port });
    const health = await server.health();
    expect(health.ok).toBe(true);
    expect(health.version).toBe("0.1.10");
  });
});

// ── MimoClient: session & command API ─────────────────

describe("MimoClient session API", () => {
  it("sets and gets per-chat sessions", () => {
    const { client } = makeClient(baseConfig, f().port);
    client.setSession("chat1", "sess-x");
    expect(client.getSessionId("chat1")).toBe("sess-x");
    expect(client.getChatIdForSession("sess-x")).toBe("chat1");
    client.clearSession("chat1");
    expect(client.getSessionId("chat1")).toBeUndefined();
    expect(client.getChatIdForSession("sess-x")).toBeUndefined();
  });

  it("lists sessions with resolved timestamps", async () => {
    const { client } = makeClient(baseConfig, f().port);
    f().sessions.set("sess-a", { title: "Alpha" });
    const sessions = await client.listSessions();
    expect(sessions).toEqual([{ id: "sess-a", title: "Alpha", updated: 2 }]);
  });

  it("deletes a session", async () => {
    const { client } = makeClient(baseConfig, f().port);
    await client.deleteSession("sess-a");
    expect(f().deleted).toContain("sess-a");
  });

  it("lists primary agents only", async () => {
    const { client } = makeClient(baseConfig, f().port);
    expect(await client.listAgents()).toEqual(["build", "plan"]);
  });

  it("replies to a permission request", async () => {
    const { client } = makeClient(baseConfig, f().port);
    await client.replyPermission("perm-1", "always");
    expect(f().permissionReplies).toEqual([{ id: "perm-1", reply: "always" }]);
  });

  it("pings via health and caches the version", async () => {
    const { client } = makeClient(baseConfig, f().port);
    expect(await client.ping()).toBe(true);
    expect(await client.getVersion()).toBe("0.1.10");
  });
});

// ── MimoClient: sendMessage ───────────────────────────

describe("MimoClient.sendMessage", () => {
  it("creates a session, prompts, and returns content from the response parts", async () => {
    const { client } = makeClient(baseConfig, f().port);
    client.startEvents().catch(() => {});
    f().responseParts = [{ type: "text", text: "hello" }];
    const run = client.sendMessage("chat1", "hello there", {
      model: "deepseek/deepseek-v4",
      agent: "build",
    });

    await waitFor(() => f().promptBodies.length > 0);
    const body = f().promptBodies[0];
    expect(body.parts).toEqual([{ type: "text", text: "hello there" }]);
    expect(body.model).toEqual({
      providerID: "deepseek",
      modelID: "deepseek-v4",
    });
    expect(body.agent).toBe("build");

    const sessionId = f().sessions.keys().next().value as string;
    // SSE pushes the same text; the response parts must win and not be
    // double-counted.
    f().pushEvent({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: sessionId,
          type: "text",
          text: "hello",
          time: { end: 1 },
        },
      },
    });

    const result = await run;
    expect(result.content).toBe("hello");
    expect(result.sessionId).toBe(sessionId);
    expect(client.getSessionId("chat1")).toBe(sessionId);
    await client.stopEvents();
  });

  it("falls back to SSE-accumulated text when the response omits parts", async () => {
    const { client } = makeClient(baseConfig, f().port);
    client.startEvents().catch(() => {});
    const run = client.sendMessage("chat1", "hi");
    await waitFor(() => f().promptBodies.length > 0);
    const sessionId = f().sessions.keys().next().value as string;
    f().pushEvent({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: sessionId,
          type: "text",
          text: "hel",
          time: { end: 1 },
        },
      },
    });
    f().pushEvent({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: sessionId,
          type: "text",
          text: "lo",
          time: { end: 2 },
        },
      },
    });

    const result = await run;
    expect(result.content).toBe("hello");
    await client.stopEvents();
  });

  it("reuses the bound session for subsequent messages", async () => {
    const { client } = makeClient(baseConfig, f().port);
    client.setSession("chat1", "sess-existing");
    const run = client.sendMessage("chat1", "again");
    await waitFor(() => f().promptBodies.length > 0);
    const created = f().sessions.size;
    expect(created).toBe(0);
    expect(f().promptBodies[0].parts).toEqual([
      { type: "text", text: "again" },
    ]);
    await client.stopEvents();
    // The prompt promise is still pending; abort so the test can exit.
    await client.abort("chat1");
    await run.catch(() => {});
  });

  it("forwards run events to opts.onEvent", async () => {
    const { client } = makeClient(baseConfig, f().port);
    client.startEvents().catch(() => {});
    const seen: Array<Record<string, unknown>> = [];
    const run = client.sendMessage("chat1", "hi", {
      onEvent: (event) => seen.push(event),
    });
    await waitFor(() => f().promptBodies.length > 0);
    const sessionId = f().sessions.keys().next().value as string;
    f().pushEvent({
      type: "message.part.updated",
      properties: { part: { sessionID: sessionId, type: "step-start" } },
    });
    f().pushEvent({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: sessionId,
          type: "text",
          text: "ok",
          time: { end: 1 },
        },
      },
    });
    await run;
    expect(seen.map((e) => e.type)).toEqual(["step_start", "text"]);
    await client.stopEvents();
  });

  it("retries with a fresh session when the bound session 404s", async () => {
    const { client } = makeClient(baseConfig, f().port);
    client.setSession("chat1", "sess-stale");
    f().messageBehavior = "404";
    const run = client.sendMessage("chat1", "retry me").catch(() => undefined);
    await waitFor(() => f().promptBodies.length >= 2);
    const createdIds = [...f().sessions.keys()];
    expect(createdIds).toHaveLength(1);
    expect(client.getSessionId("chat1")).toBe(createdIds[0]);
    await run;
  });

  it("recovers a stale session that answers 200 with an empty body", async () => {
    const { client } = makeClient(baseConfig, f().port);
    client.setSession("chat1", "sess-stale");
    f().messageBehavior = "stale-200";
    f().strictSessionGet = true;
    const run = client.sendMessage("chat1", "retry me").catch(() => undefined);
    await waitFor(() => f().promptBodies.length >= 2);
    const createdIds = [...f().sessions.keys()];
    expect(createdIds).toHaveLength(1);
    expect(client.getSessionId("chat1")).toBe(createdIds[0]);
    await run;
  });

  it("throws the response info.error when the run yields no content", async () => {
    const { client } = makeClient(baseConfig, f().port);
    f().messageBehavior = "model-error";
    await expect(client.sendMessage("chat1", "hi")).rejects.toThrow(
      /Unsupported model mimo-auto/,
    );
  });

  it("throws the server error message when the run yields no content", async () => {
    const { client } = makeClient(baseConfig, f().port);
    client.startEvents().catch(() => {});
    const run = client.sendMessage("chat1", "hi");
    await waitFor(() => f().promptBodies.length > 0);
    const sessionId = f().sessions.keys().next().value as string;
    f().pushEvent({
      type: "session.error",
      properties: {
        sessionID: sessionId,
        error: {
          name: "Error",
          data: { message: "Unsupported model mimo-auto" },
        },
      },
    });
    await expect(run).rejects.toThrow(/Unsupported model mimo-auto/);
    await client.stopEvents();
  });

  it("returns content even when a session.error arrived", async () => {
    const { client } = makeClient(baseConfig, f().port);
    client.startEvents().catch(() => {});
    const run = client.sendMessage("chat1", "hi");
    await waitFor(() => f().promptBodies.length > 0);
    const sessionId = f().sessions.keys().next().value as string;
    f().pushEvent({
      type: "session.error",
      properties: {
        sessionID: sessionId,
        error: { name: "Error", data: { message: "partial failure" } },
      },
    });
    f().pushEvent({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: sessionId,
          type: "text",
          text: "ok",
          time: { end: 1 },
        },
      },
    });
    const result = await run;
    expect(result.content).toBe("ok");
    await client.stopEvents();
  });

  it("rejects with a timeout and aborts the session", async () => {
    const config: Config = { ...baseConfig, runTimeoutMs: 150 };
    const { client } = makeClient(config, f().port);
    f().messageBehavior = "hang";
    await expect(client.sendMessage("chat1", "stall")).rejects.toThrow(
      /timed out after 150ms/,
    );
    await waitFor(() => f().aborted.length > 0);
    expect(f().aborted).toHaveLength(1);
    expect(await client.abort("chat1")).toBe(false);
  });

  it("honours a /cancel that lands before the run is registered", async () => {
    // Delays session creation so the cancel can slip in between the message
    // send and the run registration.
    f().createDelayMs = 100;
    const { client } = makeClient(baseConfig, f().port);
    const run = client.sendMessage("chat1", "hi").catch((err) => {
      if (err instanceof Error && err.message === "Task cancelled")
        return "cancelled";
      throw err;
    });
    await waitFor(() => f().sessionCreates > 0);
    expect(await client.abort("chat1")).toBe(true);
    await expect(run).resolves.toBe("cancelled");
  });
});

// ── MimoClient: permission routing ────────────────────

describe("MimoClient permission routing", () => {
  it("asks the user via onPermissionRequest when skipPermissions is false", async () => {
    const { client } = makeClient(baseConfig, f().port);
    const requests: unknown[] = [];
    client.onPermissionRequest = (request) => requests.push(request);
    client.startEvents().catch(() => {});
    await waitFor(() => f().sseConnections > 0);

    f().pushEvent({
      type: "permission.asked",
      properties: {
        id: "perm-9",
        permission: "bash",
        patterns: ["npm install"],
        sessionID: "sess-1",
      },
    });
    await waitFor(() => requests.length > 0);
    expect(requests[0]).toEqual({
      requestId: "perm-9",
      permission: "bash",
      patterns: ["npm install"],
      sessionId: "sess-1",
    });
    await client.stopEvents();
  });

  it("auto-approves when skipPermissions is true", async () => {
    const config: Config = { ...baseConfig, skipPermissions: true };
    const { client } = makeClient(config, f().port);
    client.startEvents().catch(() => {});
    await waitFor(() => f().sseConnections > 0);

    f().pushEvent({
      type: "permission.asked",
      properties: {
        id: "perm-9",
        permission: "bash",
        patterns: ["*"],
        sessionID: "sess-1",
      },
    });
    await waitFor(() => f().permissionReplies.length > 0);
    expect(f().permissionReplies).toEqual([{ id: "perm-9", reply: "once" }]);
    await client.stopEvents();
  });
});

// ── error surface ─────────────────────────────────────

describe("SessionNotFoundError", () => {
  it("carries a descriptive message", () => {
    const err = new SessionNotFoundError("/session/x/message");
    expect(err.message).toContain("Session not found");
  });
});
