import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { MimoClient } from "./mimo.js";

const root = resolve(import.meta.dirname ?? process.cwd(), "..");

// First-run: create .env from template
if (!existsSync(resolve(root, ".env"))) {
  if (existsSync(resolve(root, ".env.example"))) {
    copyFileSync(resolve(root, ".env.example"), resolve(root, ".env"));
    console.log("Created .env from .env.example — edit it with your tokens.");
  }
}

const config = loadConfig();
const bot = createBot(config);

console.log(`
  ██╗  ██╗██╗███╗   ██╗ ██████╗ ██████╗ ███████╗██████╗
  ██║  ██║██║████╗  ██║██╔════╝ ██╔══██╗██╔════╝██╔══██╗
  ███████║██║██╔██╗ ██║██║  ███╗██████╔╝█████╗  ██║  ██║
  ██╔══██║██║██║╚██╗██║██║   ██║██╔══██╗██╔══╝  ██║  ██║
  ██║  ██║██║██║ ╚████║╚██████╔╝██║  ██║███████╗██████╔╝
  ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═════╝
`);

// Check if mimo CLI is available
const checkMimo = new MimoClient(config);
const mimoOk = await checkMimo.ping();

if (mimoOk) {
  console.log("  MiMoCode CLI:  OK");
} else {
  console.warn("  MiMoCode CLI:  NOT FOUND (install: npm i -g @mimo-ai/cli)");
}

console.log(`  Allowed users: ${config.allowedUserIds.join(", ")}`);
console.log(
  `  Skip permissions: ${config.skipPermissions ? "YES (dangerous)" : "no"}`,
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
  { command: "think", description: "Run with thinking mode enabled" },
  { command: "models", description: "List available models" },
  { command: "stats", description: "Usage statistics" },
  { command: "export", description: "Export current session" },
  { command: "providers", description: "List AI providers" },
  { command: "delete", description: "Delete a session" },
  { command: "version", description: "MimoCode version" },
]);
console.log(`  Commands registered: ${cmdResult ? "OK" : "FAILED"}`);

console.log("\n  Bot started. Send /start in Telegram.\n");

const stop = bot.start();
process.on("SIGTERM", () => {
  console.log("\n  Shutting down...");
  bot.stop();
});
process.on("SIGINT", () => {
  console.log("\n  Shutting down...");
  bot.stop();
});
await stop;
