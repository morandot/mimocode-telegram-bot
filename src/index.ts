import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";

const root = resolve(import.meta.dirname ?? process.cwd(), "..");

// First-run: create .env from template
if (!existsSync(resolve(root, ".env"))) {
  if (existsSync(resolve(root, ".env.example"))) {
    copyFileSync(resolve(root, ".env.example"), resolve(root, ".env"));
    console.log("Created .env from .env.example — edit it with your tokens.");
  }
}

const config = loadConfig();
const { bot, client, server } = createBot(config);

console.log(`
  ██╗  ██╗██╗███╗   ██╗ ██████╗ ██████╗ ███████╗██████╗
  ██║  ██║██║████╗  ██║██╔════╝ ██╔══██╗██╔════╝██╔══██╗
  ███████║██║██╔██╗ ██║██║  ███╗██████╔╝█████╗  ██║  ██║
  ██╔══██║██║██║╚██╗██║██║   ██║██╔══██╗██╔══╝  ██║  ██║
  ██║  ██║██║██║ ╚████║╚██████╔╝██║  ██║███████╗██████╔╝
  ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═════╝
`);

// Start (or connect to) the mimo serve process.
console.log(
  `  Server:    ${server.url}${server.isManaged ? " (managed)" : " (external)"}`,
);
try {
  await server.start();
} catch (err) {
  console.error(
    `  MiMoCode server: FAILED — ${err instanceof Error ? err.message : err}\n` +
      `  Install: npm i -g @mimo-ai/cli\n` +
      `  Or set MIMO_CLI_PATH to the full path of the mimo executable\n` +
      `  Or set MIMO_API_URL to an already-running mimo serve instance`,
  );
  process.exit(1);
}

const version = await client.getVersion();
console.log(`  MiMoCode:  ${version || "OK"}`);

// Open the SSE event stream (reconnects automatically).
client.startEvents().catch((err) => {
  console.error(`  Event stream: FAILED — ${err.message}`);
});

console.log(`  Allowed users: ${config.allowedUserIds.join(", ")}`);
console.log(
  `  Permissions: ${config.skipPermissions ? "auto-approve (dangerous)" : "interactive buttons"}`,
);

console.log("\n  Registering bot commands...");
const cmdResult = await bot.api.setMyCommands([
  { command: "start", description: "Show help & quick actions" },
  { command: "help", description: "Show all commands" },
  { command: "workdir", description: "Browse & change workspace directory" },
  { command: "new", description: "Start a new session" },
  { command: "cancel", description: "Stop running task" },
  { command: "status", description: "Connection & session info" },
  { command: "sessions", description: "List all sessions" },
  { command: "model", description: "Switch model" },
  { command: "use", description: "Switch agent (build/plan/compose)" },
  { command: "compose", description: "Run compose mode workflow" },
  { command: "max", description: "Run with max parallel sampling" },
  { command: "think", description: "Run with reasoning shown" },
  { command: "delete", description: "Delete a session" },
  { command: "version", description: "MimoCode version" },
]);
console.log(`  Commands registered: ${cmdResult ? "OK" : "FAILED"}`);

console.log("\n  Bot started. Send /start in Telegram.\n");

const stop = bot.start();
const shutdown = async () => {
  console.log("\n  Shutting down...");
  await client.stopEvents();
  await server.stop();
  await bot.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
await stop;
