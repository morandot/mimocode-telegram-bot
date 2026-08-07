// Integration test: exercise MimoServer + MimoClient against the real `mimo`
// CLI in serve mode. Requires a live mimo CLI (skips cleanly when missing).
//
//   bun tests/integration.ts
//   MIMO_SKIP_REAL_PROMPT=1 bun tests/integration.ts   # skip paid LLM prompts

import { checkAuth, sanitizeError } from "../src/bot.js";
import type { Config } from "../src/config.js";
import { MimoClient, MimoServer, type SendMessageOpts } from "../src/mimo.js";

const config: Config = {
  telegramToken: "test-token",
  allowedUserIds: ["6985614590"],
  mimoWorkDir: "/tmp/mimocode-test",
  workdirRoot: "/tmp/mimocode-test",
  workdirBrowseEnabled: false,
  skipPermissions: true,
  servePort: 4123,
  mimoCliPath: process.env.MIMO_CLI_PATH ?? "mimo",
  runTimeoutMs: 120_000,
  showText: "full",
  showReasoning: "off",
  showToolUse: "off",
  showStepStart: "off",
  showStepFinish: "off",
};

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

console.log("Starting real mimo serve...");
const server = new MimoServer(config);
let client: MimoClient;

try {
  await server.start();
  client = new MimoClient(config, server);
} catch (err) {
  console.log(
    `\nSKIP: mimo CLI not available or serve failed to start (${(err as Error).message}).\n` +
      "Install with: npm i -g @mimo-ai/cli",
  );
  process.exit(0);
}

await check("server.health() reports ok with version", async () => {
  const health = await server.health();
  if (!health.ok) throw new Error("health check failed");
  if (!health.version) throw new Error("missing version");
  console.log(`    version: ${health.version}`);
});

await check("client.ping() / getVersion()", async () => {
  if (!(await client.ping())) throw new Error("ping failed");
  const v = await client.getVersion();
  if (!v) throw new Error("empty version");
  console.log(`    version: ${v}`);
});

await check("listAgents() returns primary agents", async () => {
  const agents = await client.listAgents();
  if (!agents.includes("build"))
    throw new Error(`build missing: ${agents.join(",")}`);
  console.log(`    agents: ${agents.join(", ")}`);
});

await check("setSession / getSessionId round-trip", () => {
  client.setSession("chat-1", "ses_integration_test");
  if (client.getSessionId("chat-1") !== "ses_integration_test") {
    throw new Error("session mismatch");
  }
  client.clearSession("chat-1");
});

await check("abort() on idle chat returns false", async () => {
  if (await client.abort("chat-1")) throw new Error("expected false");
});

const runRealPrompt = process.env.MIMO_SKIP_REAL_PROMPT !== "1";

if (runRealPrompt) {
  const testModel = process.env.MIMO_TEST_MODEL ?? "mimo/mimo-auto";

  // Model availability depends on the host's credentials; treat a clean
  // "model unavailable / quota exhausted" rejection as an environment skip,
  // everything else (transport errors, protocol breaks) as a real failure.
  const isModelUnavailable = (message: string) =>
    /Unsupported model|model[^a-z]*(not found|not available|invalid|unknown)/i.test(
      message,
    ) ||
    /no model/i.test(message) ||
    /exceeded your current quota|insufficient.*quota|billing/i.test(message);

  await check("sendMessage() with a real prompt returns content", async () => {
    const opts: SendMessageOpts = { model: testModel };
    try {
      const result = await client.sendMessage(
        "integration-test-chat",
        "Reply with exactly: PONG",
        opts,
      );
      if (!result.content || result.content.length === 0) {
        throw new Error("empty content");
      }
      console.log(
        `    content (first 80 chars): ${result.content.slice(0, 80).replace(/\n/g, " ")}`,
      );
      console.log(`    session: ${result.sessionId?.slice(0, 16)}...`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isModelUnavailable(message)) {
        console.log(`    (skipped: model unavailable — ${message})`);
        return;
      }
      throw err;
    }
  });

  await check(
    "sendMessage() session recovery: stale session retries",
    async () => {
      const testChat = "integration-test-recovery";
      client.setSession(testChat, "ses_does_not_exist_zzz");
      try {
        const result = await client.sendMessage(
          testChat,
          "Reply with exactly: RECOVERED",
          { model: testModel },
        );
        if (!result.content) throw new Error("no content after recovery");
        const newSession = client.getSessionId(testChat);
        if (newSession === "ses_does_not_exist_zzz") {
          throw new Error("session was not reset after recovery");
        }
        console.log(`    recovered session: ${newSession?.slice(0, 16)}...`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isModelUnavailable(message)) {
          console.log(`    (skipped: model unavailable — ${message})`);
          return;
        }
        throw err;
      }
    },
  );
} else {
  console.log("  (skipping real LLM prompts — MIMO_SKIP_REAL_PROMPT=1)");
}

await check("listSessions() resolves", async () => {
  const sessions = await client.listSessions();
  console.log(`    ${sessions.length} sessions in store`);
});

await check("deleteSession() on a fresh session", async () => {
  const id = await client.createSession("integration-cleanup");
  await client.deleteSession(id);
  const sessions = await client.listSessions();
  if (sessions.some((s) => s.id === id))
    throw new Error("session still listed");
});

// ── in-process helpers ──
await check("checkAuth: allowed user", () => {
  if (!checkAuth({ from: { id: 6985614590 } }, config)) {
    throw new Error("should be allowed");
  }
});

await check("checkAuth: disallowed user", () => {
  if (checkAuth({ from: { id: 999 } }, config)) {
    throw new Error("should be denied");
  }
});

await check("sanitizeError: masks local paths", () => {
  const out = sanitizeError("failed at /tmp/mimocode-test/secret/file.ts");
  if (out.includes("/tmp/mimocode-test")) throw new Error("path leaked");
  if (!out.includes("<path>")) throw new Error("not masked");
});

await check("sanitizeError: strips ANSI", () => {
  const out = sanitizeError("\x1B[31mERROR\x1B[0m");
  if (out.includes("\x1B")) throw new Error("ANSI leaked");
});

await server.stop();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
