import fs from "node:fs";
import path from "node:path";
import { Bot, type Context, InlineKeyboard, InputFile } from "grammy";
import { type Config, isAllowed, type Verbosity } from "./config.js";
import {
  formatLong,
  parseJsonSafe,
  stripSystemTags,
  wrapCode,
} from "./format.js";
import { MimoClient, type SendMessageOpts } from "./mimo.js";

export function checkAuth(
  ctx: { from?: { id: number } },
  config: Config,
): boolean {
  if (!ctx.from) return false;
  return isAllowed(String(ctx.from.id), config);
}

export function sanitizeError(raw: string): string {
  let clean = raw
    .replace(/\/[\w./-]+/g, "<path>")
    .replace(/[A-Z]:\\[\w\\.-]+/gi, "<path>");
  clean = clean.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  if (clean.length > 100) clean = `${clean.slice(0, 100)}...`;
  return clean || "Unknown error";
}

/** True iff `candidate` is `root` or strictly inside it. */
export function isInsideRoot(candidate: string, root: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  return c === r || c.startsWith(r + path.sep);
}

const eventVerbosityKey: Record<string, keyof Config> = {
  text: "showText",
  reasoning: "showReasoning",
  tool_use: "showToolUse",
  tool_script: "showToolUse",
  step_start: "showStepStart",
  step_finish: "showStepFinish",
};

function getVerbosity(evType: string, cfg: Config): Verbosity {
  const key = eventVerbosityKey[evType];
  if (!key) return "off";
  return cfg[key] as Verbosity;
}

function hintIcon(evType: string): string {
  switch (evType) {
    case "reasoning":
      return "💭";
    case "tool_use":
    case "tool_script":
      return "🔧";
    case "step_start":
      return "⟳";
    case "step_finish":
      return "✓";
    default:
      return "⏳";
  }
}

export function formatEventHint(event: Record<string, unknown>): string {
  const type = event.type as string;
  const part = event.part as Record<string, unknown> | undefined;
  switch (type) {
    case "reasoning":
      return "💭 正在思考...";
    case "tool_use": {
      const tool = (part?.tool as string) ?? "";
      const state = part?.state as Record<string, unknown> | undefined;
      const title = (state?.title as string) ?? "";
      const inp = state?.input as Record<string, unknown> | undefined;
      const cmd =
        (inp?.command as string) ?? (inp?.description as string) ?? "";
      const error = (state?.error as string) ?? "";
      let hint = `🔧 ${tool}: ${(title || cmd).slice(0, 80)}`;
      if (error) hint += ` ❌ ${error.slice(0, 60)}`;
      return hint;
    }
    case "tool_script":
      return "⏳ 执行脚本...";
    case "step_start":
      return "⟳ 正在处理...";
    case "step_finish": {
      const tokens = part?.tokens as Record<string, number> | undefined;
      const reason = (part?.reason as string) ?? "";
      const cost = part?.cost as number | undefined;
      let extra = "";
      if (tokens) extra += ` ${tokens.total ?? 0}t`;
      if (cost != null) extra += ` $${cost.toFixed(4)}`;
      return `✓ 步骤完成 (${reason}${extra})`;
    }
    default:
      return "⏳ 处理中...";
  }
}

export function formatEventBrief(event: Record<string, unknown>): string {
  const type = event.type as string;
  const part = event.part as Record<string, unknown> | undefined;
  switch (type) {
    case "reasoning": {
      const text = (part?.text as string) ?? "";
      const firstLine = text.split("\n")[0] ?? "";
      return `💭 ${firstLine.slice(0, 200)}`;
    }
    case "tool_use": {
      const tool = (part?.tool as string) ?? "";
      const state = part?.state as Record<string, unknown> | undefined;
      const title = (state?.title as string) ?? "";
      const inp = state?.input as Record<string, unknown> | undefined;
      const cmd =
        (inp?.command as string) ?? (inp?.description as string) ?? "";
      const error = (state?.error as string) ?? "";
      let brief = `🔧 ${tool}: ${(title || cmd).slice(0, 200)}`;
      if (error) brief += ` ❌ ${error.slice(0, 100)}`;
      return brief;
    }
    case "tool_script": {
      const tool = (part?.tool as string) ?? "";
      return `🔧 tool_script${tool ? `: ${tool}` : ""}`;
    }
    case "step_start":
      return "⟳ step start";
    case "step_finish": {
      const tokens = part?.tokens as Record<string, number> | undefined;
      const reason = (part?.reason as string) ?? "";
      if (tokens)
        return `✓ step finish (${reason}, ${tokens.total ?? 0} tokens)`;
      return `✓ step finish (${reason})`;
    }
    default:
      return `${type}`;
  }
}

export function formatEventFull(event: Record<string, unknown>): string {
  const type = event.type as string;
  const part = event.part as Record<string, unknown> | undefined;
  switch (type) {
    case "reasoning": {
      const text = (part?.text as string) ?? "";
      return `💭 思考:\n${text}`;
    }
    case "tool_use": {
      const tool = (part?.tool as string) ?? "";
      const state = part?.state as Record<string, unknown> | undefined;
      const inp = state?.input as Record<string, unknown> | undefined;
      const output = (state?.output as string) ?? "";
      const error = (state?.error as string) ?? "";
      const lines = [`🔧 ${tool}`];
      const cmd = inp?.command as string | undefined;
      const desc = inp?.description as string | undefined;
      if (cmd) lines.push(`  command: ${cmd}`);
      if (desc && desc !== cmd) lines.push(`  description: ${desc}`);
      if (output) lines.push(`  output: ${output.slice(0, 500)}`);
      if (error) lines.push(`  ❌ error: ${error.slice(0, 500)}`);
      return lines.join("\n");
    }
    case "tool_script": {
      const tasks = part?.tasks as
        | Array<{ tool?: string; command?: string; description?: string }>
        | undefined;
      if (tasks && tasks.length > 0) {
        const lines = [`📋 编排 ${tasks.length} 个工具`];
        for (const t of tasks) {
          const label = t.command ?? t.description ?? "";
          lines.push(`  ${t.tool ?? "?"}${label ? `: ${label}` : ""}`);
        }
        return lines.join("\n");
      }
      const tool = (part?.tool as string) ?? "";
      return `📋 tool_script${tool ? `: ${tool}` : ""}`;
    }
    case "step_start":
      return "⟳ step start";
    case "step_finish": {
      const tokens = part?.tokens as Record<string, number> | undefined;
      const reason = (part?.reason as string) ?? "";
      const cost = part?.cost as number | undefined;
      if (tokens) {
        return `✓ step finish\n  reason: ${reason}\n  tokens: ${tokens.total ?? 0} (in:${tokens.input ?? 0} out:${tokens.output ?? 0})${cost != null ? ` cost:$${cost.toFixed(6)}` : ""}`;
      }
      return `✓ step finish (${reason})`;
    }
    default:
      return `${type}: ${JSON.stringify(event).slice(0, 500)}`;
  }
}

/**
 * Above this many chunks, sendLong ships the response as a single .txt
 * document instead of a flood of chat messages. High enough that ordinary
 * multi-part replies still arrive inline.
 */
export const DOCUMENT_FALLBACK_THRESHOLD = 5;

/** True when a response is long enough to prefer a document over N messages. */
export function shouldFallbackToDocument(chunkCount: number): boolean {
  return chunkCount > DOCUMENT_FALLBACK_THRESHOLD;
}

/**
 * Build the plain-text body for the document fallback: strip Telegram HTML
 * tags from each chunk and rejoin with a blank line so paragraphs survive.
 *
 * Chunks come back from markdownToTelegramHtml with `escapeHtml` applied, so
 * `<`, `>`, `&` live as `&lt;`, `&gt;`, `&amp;`. Inline messages rely on
 * Telegram's HTML parser to render those back into characters; a .txt
 * document bypasses that parser, so we must unescape ourselves — otherwise
 * `if (a < b && c > d)` shows up as `if (a &lt; b &amp;&amp; c &gt; d)`.
 * `&amp;` is decoded last so a literal `&amp;lt;` is not double-decoded.
 */
export function prepareDocumentContent(chunks: string[]): string {
  return chunks
    .map((c) => c.replace(/<[^>]+>/g, ""))
    .join("\n\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function createBot(config: Config) {
  const bot = new Bot(config.telegramToken);
  const mimo = new MimoClient(config);
  const processing = new Set<string>();
  const lastSessions = new Map<
    string,
    { sessions: Array<{ id: string; title: string }>; ts: number }
  >();
  const browsingPaths = new Map<string, string>();
  const browsingSubdirs = new Map<string, string[]>();
  // F5: typed state for folder-name creation
  interface WaitEntry {
    parentPath: string;
    ts: number;
  }
  const waitingForFolderName = new Map<string, WaitEntry>();
  const pendingFolderName = new Map<string, string>();

  async function sendLong(chatId: string, text: string) {
    const chunks = formatLong(text);

    // Too many chunks → send as a single document instead of flooding the
    // chat. Fall back to inline messages if the document send fails.
    if (shouldFallbackToDocument(chunks.length)) {
      const body = prepareDocumentContent(chunks);
      try {
        await bot.api.sendDocument(
          chatId,
          new InputFile(Buffer.from(body, "utf-8"), "response.txt"),
        );
        return;
      } catch {
        // fall through to per-chunk sending below
      }
    }

    for (const chunk of chunks) {
      try {
        await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
      } catch {
        await bot.api.sendMessage(chatId, chunk.replace(/<[^>]+>/g, ""));
      }
    }
  }

  type MimoRunOpts = {
    logPrefix: string;
    mimoOpts?: SendMessageOpts;
  };

  async function runMimoCommand(ctx: Context, text: string, opts: MimoRunOpts) {
    const chatId = String(ctx.chat?.id);
    if (processing.has(chatId)) {
      await ctx.reply("Task running. Wait or /cancel.");
      return;
    }
    processing.add(chatId);
    const startTime = Date.now();

    // Keep the "typing…" indicator alive while mimo is working.
    // Telegram expires the status after ~5 seconds, so refresh every 4s.
    const typingWarn = (e: unknown) =>
      console.warn(
        `[typing] chat=${chatId}:`,
        e instanceof Error ? e.message : e,
      );
    const typingInterval = setInterval(() => {
      bot.api.sendChatAction(chatId, "typing").catch(typingWarn);
    }, 4000);
    bot.api.sendChatAction(chatId, "typing").catch(typingWarn);

    try {
      const onEvent = (event: Record<string, unknown>) => {
        const evType = event.type as string | undefined;
        if (!evType) return;
        const v = getVerbosity(evType, config);
        if (v === "off") return;
        if (evType === "text") {
          if (v === "brief") {
            const part = event.part as { text?: string } | undefined;
            const firstLine = (part?.text ?? "").split("\n")[0] ?? "";
            if (firstLine) {
              bot.api
                .sendMessage(chatId, firstLine.slice(0, 500))
                .catch(() => {});
            }
          } else if (v === "hint") {
            bot.api
              .sendMessage(chatId, `${hintIcon(evType)} 回复中...`)
              .catch(() => {});
          }
          return;
        }
        if (v === "hint") {
          bot.api.sendMessage(chatId, formatEventHint(event)).catch(() => {});
        } else if (v === "brief") {
          bot.api.sendMessage(chatId, formatEventBrief(event)).catch(() => {});
        } else if (v === "full") {
          bot.api.sendMessage(chatId, formatEventFull(event)).catch(() => {});
        }
      };

      const mergedOpts: SendMessageOpts = {
        ...opts.mimoOpts,
        onEvent,
      };
      const result = await mimo.sendMessage(chatId, text, mergedOpts);

      if (!result.content || config.showText === "off") {
        return;
      }
      if (config.showText === "full") {
        await sendLong(chatId, stripSystemTags(result.content));
      } else if (config.showText === "brief") {
        const firstLine = result.content.split("\n")[0] ?? result.content;
        await bot.api
          .sendMessage(chatId, firstLine.slice(0, 500))
          .catch(() => {});
      } else if (config.showText === "hint") {
        await bot.api.sendMessage(chatId, "✓ 已回复").catch(() => {});
      }
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `[${new Date().toISOString()}] ${opts.logPrefix} chat=${chatId} time=${elapsed}s`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await ctx.reply(`Error: ${sanitizeError(msg)}`);
      } catch {}
    } finally {
      clearInterval(typingInterval);
      processing.delete(chatId);
    }
  }

  async function renderExplorer(ctx: Context, chatId: string, isEdit = false) {
    // F5: sweep stale folder-name wait entries (5 min TTL)
    const now = Date.now();
    for (const [key, entry] of waitingForFolderName) {
      if (now - entry.ts > 5 * 60_000) {
        waitingForFolderName.delete(key);
        pendingFolderName.delete(key);
      }
    }

    const rawCurrent = browsingPaths.get(chatId) ?? mimo.getWorkDir();
    const current = isInsideRoot(rawCurrent, config.workdirRoot)
      ? rawCurrent
      : config.workdirRoot;
    let subdirs: string[] = [];
    let errMessage = "";
    try {
      if (fs.existsSync(current)) {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        subdirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name)
          .sort();
      } else {
        errMessage = `Directory does not exist: <code>${current}</code>`;
      }
    } catch (err) {
      errMessage = `Error reading directory: ${(err as Error).message}`;
    }

    browsingSubdirs.set(chatId, subdirs);

    const kb = new InlineKeyboard();

    if (subdirs.length > 0) {
      for (let i = 0; i < subdirs.length; i++) {
        kb.text(`📁 ${subdirs[i]}`, `wd:nav:${i}`);
        if (i % 2 === 1) kb.row();
      }
      if (subdirs.length % 2 !== 0) kb.row();
    } else if (!errMessage) {
      errMessage = "<i>(No subdirectories found)</i>";
    }

    const isRoot = path.resolve(current) === path.resolve(config.workdirRoot);
    if (!isRoot) {
      kb.text("⬅️ Up", "wd:nav:up");
    }
    kb.text("➕ Create New Folder Here", "wd:newfolder").row();
    kb.text("✅ Select This", "wd:sel");
    kb.text("❌ Close", "wd:close");

    const messageText =
      `<b>📁 Workspace Explorer</b>\n\n` +
      `Current Path:\n<code>${current}</code>\n\n` +
      (errMessage ? `${errMessage}\n\n` : "") +
      `Select a folder below to navigate, then click <b>Select This</b> to confirm.`;

    if (isEdit) {
      try {
        await ctx.editMessageText(messageText, {
          parse_mode: "HTML",
          reply_markup: kb,
        });
      } catch (err) {
        console.error("Failed to edit explorer message:", err);
      }
    } else {
      await ctx.reply(messageText, {
        parse_mode: "HTML",
        reply_markup: kb,
      });
    }
  }

  // ── /workdir ─────────────────────────────────────────
  bot.command("workdir", async (ctx) => {
    if (!checkAuth(ctx, config)) {
      await ctx.reply("Access denied.");
      return;
    }
    if (!config.workdirBrowseEnabled) {
      await ctx.reply(
        "The /workdir feature is not enabled. Set <code>MIMO_WORKDIR_BROWSE=true</code> to enable.",
        { parse_mode: "HTML" },
      );
      return;
    }
    const chatId = String(ctx.chat.id);
    // F1: seed browsing from workdirRoot, not from mimo's workdir
    browsingPaths.set(chatId, config.workdirRoot);
    await renderExplorer(ctx, chatId);
  });

  function mainMenuKb(): InlineKeyboard {
    return new InlineKeyboard()
      .text("Status", "/status")
      .text("Sessions", "/sessions")
      .row()
      .text("Models", "/models")
      .text("Stats", "/stats")
      .row()
      .text("New Session", "/new");
  }

  // ── /start ───────────────────────────────────────────
  bot.command("start", async (ctx) => {
    if (!checkAuth(ctx, config)) {
      await ctx.reply("Access denied.");
      return;
    }
    const version = await mimo.getVersion();

    await ctx.reply(
      `<b>MiMoCode Bot</b> v${version}\n\n` +
        `Send any message to chat with your MiMoCode agent.\n\n` +
        `<b>Quick Actions</b>`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  });

  // ── /help ────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    await ctx.reply(
      `<b>Commands</b>\n\n` +
        `<b>Chat</b>\n` +
        `Send any text to chat with MiMoCode\n\n` +
        `<b>Sessions</b>\n` +
        `/new — Start new session\n` +
        `/cancel — Stop running task\n` +
        `/sessions — List sessions (reply number to switch)\n` +
        `/export — Export session as JSON\n` +
        `/delete — Delete a session\n\n` +
        `<b>Modes</b>\n` +
        `/use — Switch agent (build/plan/compose)\n` +
        `/compose — Compose mode workflow\n` +
        `/max — Max parallel sampling\n` +
        `/think — Run with thinking mode\n\n` +
        `<b>Info</b>\n` +
        `/model — Switch model\n` +
        `/models — List models\n` +
        `/status — Connection info\n` +
        `/stats — Usage stats\n` +
        `/providers — List providers\n` +
        `/version — Version info`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  });

  // ── /version ─────────────────────────────────────────
  bot.command("version", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const v = await mimo.getVersion();
    await ctx.reply(`MiMoCode v${v}`);
  });

  // ── /new ─────────────────────────────────────────────
  bot.command("new", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);

    const oldSession = mimo.getSessionId(chatId);
    if (oldSession) {
      const r = await mimo.exec(["session", "delete", oldSession]);
      if (r.code !== 0) {
        await ctx.reply(
          `Failed to clear old session: ${sanitizeError(r.stderr)}`,
        );
        return;
      }
    }
    mimo.clearSession(chatId);
    await ctx.reply("Session cleared. Send a new message to start fresh.");
  });

  // ── /status ──────────────────────────────────────────
  bot.command("status", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);

    const [version, sessionList] = await Promise.all([
      mimo.getVersion(),
      mimo.exec(["session", "list", "--format", "json"]),
    ]);

    const sessions = parseJsonSafe<
      Array<{ id: string; title: string; updated: number }>
    >(sessionList.stdout, []);

    const currentSession = mimo.getSessionId(chatId);
    const current = sessions.find((s) => s.id === currentSession);
    const model = mimo.getModel(chatId);
    const agent = mimo.getAgent(chatId) ?? "build";

    const lines = [
      `<b>Status</b>`,
      ``,
      `Version: ${version}`,
      `Sessions: ${sessions.length}`,
      `Model: <code>${model ?? "default"}</code>`,
      `Agent: <code>${agent}</code>`,
    ];

    if (current) {
      const ago = Date.now() - current.updated;
      const mins = Math.floor(ago / 60000);
      lines.push(
        ``,
        `Current: <code>${current.id.slice(0, 16)}...</code>`,
        `Title: ${current.title}`,
        `Active: ${mins < 1 ? "just now" : `${mins}m ago`}`,
      );
    } else {
      lines.push(``, `No active session.`);
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // ── /sessions ────────────────────────────────────────
  bot.command("sessions", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);

    const r = await mimo.exec(["session", "list", "--format", "json"]);
    const sessions = parseJsonSafe<
      Array<{
        id: string;
        title: string;
        updated: number;
      }>
    >(r.stdout, []);

    if (sessions.length === 0) {
      await ctx.reply("No sessions found.");
      return;
    }

    const currentSession = mimo.getSessionId(chatId);
    const lines = [`<b>Sessions</b> (${sessions.length})\n`];

    for (let i = 0; i < Math.min(sessions.length, 15); i++) {
      const s = sessions[i];
      const isCurrent = s.id === currentSession;
      const marker = isCurrent ? " *" : "";
      const ago = Date.now() - s.updated;
      const timeStr =
        ago < 60000
          ? "now"
          : ago < 3600000
            ? `${Math.floor(ago / 60000)}m`
            : ago < 86400000
              ? `${Math.floor(ago / 3600000)}h`
              : `${Math.floor(ago / 86400000)}d`;
      lines.push(
        `${i + 1}. <code>${s.id.slice(0, 16)}</code>${marker} ${timeStr}`,
        `   ${s.title}`,
        ``,
      );
    }

    if (sessions.length > 15) {
      lines.push(`... and ${sessions.length - 15} more`);
    }

    lines.push(`Reply a number to switch session`);

    const now = Date.now();
    for (const [key, val] of lastSessions) {
      if (now - val.ts > 5 * 60_000) lastSessions.delete(key);
    }
    lastSessions.set(chatId, {
      sessions: sessions.map((s) => ({ id: s.id, title: s.title })),
      ts: now,
    });
    await sendLong(chatId, lines.join("\n"));
  });

  // ── /model ──────────────────────────────────────────
  bot.command("model", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);
    const target = ctx.match?.trim();

    if (!target) {
      const current = mimo.getModel(chatId);
      const r = await mimo.exec(["models"], { timeoutMs: 10_000 });
      const models = r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const lines = [
        `<b>Model</b>: <code>${current ?? "default"}</code>\n`,
        models.map((m) => `• <code>${m}</code>`).join("\n"),
        `\nUsage: /model &lt;provider/model&gt;`,
      ];
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      return;
    }

    mimo.setModel(chatId, target);
    await ctx.reply(`Model → <code>${target}</code>`, { parse_mode: "HTML" });
  });

  // ── /use ───────────────────────────────────────────
  bot.command("use", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);
    const target = ctx.match?.trim();

    if (!target) {
      const current = mimo.getAgent(chatId) ?? "build";
      const lines = [
        `<b>Agent</b>: <code>${current}</code>\n`,
        `• <code>build</code> — Default execution`,
        `• <code>plan</code> — Read-only analysis`,
        `• <code>compose</code> — Full workflow`,
        `\nUsage: /use &lt;agent&gt;`,
      ];
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      return;
    }

    const validAgents = ["build", "plan", "compose"];
    if (!validAgents.includes(target)) {
      await ctx.reply(`Choose from: ${validAgents.join(", ")}`);
      return;
    }

    mimo.setAgent(chatId, target);
    await ctx.reply(`Agent → <code>${target}</code>`, { parse_mode: "HTML" });
  });

  // ── /compose ─────────────────────────────────────────
  bot.command("compose", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const text = ctx.match?.trim();
    if (!text) {
      await ctx.reply(
        `Usage: /compose &lt;your idea&gt;\n\n` +
          `Runs: plan → code → test → review`,
      );
      return;
    }
    await runMimoCommand(ctx, text, {
      logPrefix: "compose",
      mimoOpts: { agent: "compose" },
    });
  });

  // ── /max ────────────────────────────────────────────
  bot.command("max", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const text = ctx.match?.trim();
    if (!text) {
      await ctx.reply("Usage: /max &lt;complex task&gt;");
      return;
    }
    await runMimoCommand(ctx, text, {
      logPrefix: "max",
      mimoOpts: { variant: "max" },
    });
  });

  // ── /think ───────────────────────────────────────────
  // Like a plain chat, but enables extended reasoning (--thinking) for the
  // single run. The --thinking flag is already wired into sendMessage; this
  // just exposes it as a Telegram command.
  bot.command("think", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const text = ctx.match?.trim();
    if (!text) {
      await ctx.reply(
        `Usage: /think &lt;your question&gt;\n\n` +
          `Runs with thinking mode enabled for extended reasoning.`,
      );
      return;
    }
    await runMimoCommand(ctx, text, {
      logPrefix: "think",
      mimoOpts: { thinking: true },
    });
  });

  // ── /models ──────────────────────────────────────────
  bot.command("models", async (ctx) => {
    if (!checkAuth(ctx, config)) return;

    const r = await mimo.exec(["models"], { timeoutMs: 10_000 });
    const models = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (models.length === 0) {
      await ctx.reply("No models found.");
      return;
    }

    const lines = [
      `<b>Models</b> (${models.length})\n`,
      models.map((m) => `• <code>${m}</code>`).join("\n"),
    ];

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // ── /stats ───────────────────────────────────────────
  bot.command("stats", async (ctx) => {
    if (!checkAuth(ctx, config)) return;

    const r = await mimo.exec(["stats"], { timeoutMs: 10_000 });
    const output = r.stdout.trim();
    if (!output) {
      await ctx.reply("No stats available.");
      return;
    }
    await ctx.reply(wrapCode(output), { parse_mode: "HTML" });
  });

  // ── /export ──────────────────────────────────────────
  bot.command("export", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);

    const sessionId = mimo.getSessionId(chatId);
    if (!sessionId) {
      await ctx.reply("No active session to export.");
      return;
    }

    const r = await mimo.exec(["export", sessionId], { timeoutMs: 15_000 });
    if (r.code !== 0) {
      await ctx.reply(`Export failed: ${sanitizeError(r.stderr)}`);
      return;
    }

    const data = Buffer.from(r.stdout, "utf-8");
    const file = new InputFile(data, `session-${sessionId.slice(0, 16)}.json`);
    await ctx.replyWithDocument(file).catch(async () => {
      await ctx.reply(r.stdout.slice(0, 4000));
    });
  });

  // ── /providers ───────────────────────────────────────
  bot.command("providers", async (ctx) => {
    if (!checkAuth(ctx, config)) return;

    const r = await mimo.exec(["providers", "list"], { timeoutMs: 10_000 });
    const output = r.stdout.trim();
    if (!output) {
      await ctx.reply("No providers configured.");
      return;
    }
    await ctx.reply(wrapCode(output), { parse_mode: "HTML" });
  });

  // ── /delete ──────────────────────────────────────────
  bot.command("delete", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);

    const sessionId = ctx.match?.trim();
    if (!sessionId) {
      const current = mimo.getSessionId(chatId);
      if (!current) {
        await ctx.reply("No active session to delete.");
        return;
      }
      const r = await mimo.exec(["session", "delete", current]);
      if (r.code === 0) {
        mimo.clearSession(chatId);
        await ctx.reply("Session deleted.");
      } else {
        await ctx.reply(`Delete failed: ${sanitizeError(r.stderr)}`);
      }
      return;
    }

    const r = await mimo.exec(["session", "delete", sessionId]);
    if (r.code === 0) {
      if (mimo.getSessionId(chatId) === sessionId) {
        mimo.clearSession(chatId);
      }
      await ctx.reply("Session deleted.");
    } else {
      await ctx.reply(`Delete failed: ${sanitizeError(r.stderr)}`);
    }
  });

  // ── /cancel, /stop ──────────────────────────────────
  bot.command(["cancel", "stop"], async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);
    // F5: clean up folder-creation wait state on cancel
    const hadWaitEntry = waitingForFolderName.has(chatId);
    waitingForFolderName.delete(chatId);
    pendingFolderName.delete(chatId);
    if (mimo.abort(chatId)) {
      processing.delete(chatId);
      const parts = ["Task cancelled."];
      if (hadWaitEntry) parts.push("Folder creation also cancelled.");
      await ctx.reply(parts.join(" "));
    } else if (processing.has(chatId)) {
      processing.delete(chatId);
      await ctx.reply("Task cancelled (process already finished).");
    } else if (hadWaitEntry) {
      await ctx.reply("Folder creation cancelled.");
    } else {
      await ctx.reply("No task running.");
    }
  });

  // ── Text messages → mimo run ─────────────────────────
  bot.on("message:text", async (ctx) => {
    if (!ctx.from) return;
    const userId = String(ctx.from.id);
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text;

    if (!isAllowed(userId, config)) {
      await ctx.reply("Access denied.");
      return;
    }

    if (waitingForFolderName.has(chatId)) {
      // F5: typed access — extract parentPath from structured state
      const waitEntry = waitingForFolderName.get(chatId);
      if (!waitEntry) {
        waitingForFolderName.delete(chatId);
        await ctx.reply("Folder creation expired. Use /workdir to try again.");
        return;
      }
      const parentPath = waitEntry.parentPath;
      const folderName = text.trim();

      const isValid =
        folderName.length > 0 &&
        !/[/\\?%*:|"<>]/.test(folderName) &&
        folderName !== "." &&
        folderName !== "..";
      if (!isValid) {
        const cancelKb = new InlineKeyboard().text(
          "🔙 Cancel",
          "wd:mkdir:cancel",
        );
        await ctx.reply(
          `❌ <b>Invalid folder name!</b>\n\n` +
            `A folder name cannot contain slashes or special characters, and cannot be "." or "..".\n\n` +
            `Please try again, or click <b>Cancel</b>:`,
          { parse_mode: "HTML", reply_markup: cancelKb },
        );
        return;
      }

      pendingFolderName.set(chatId, folderName);

      const confirmText =
        `<b>❓ Confirm Directory Creation</b>\n\n` +
        `Do you want to create a new folder named <code>${folderName}</code> inside:\n<code>${parentPath}</code>?\n\n` +
        `Please click <b>Confirm</b> to create, <b>Don't Confirm</b> to enter a different name, or <b>Cancel</b> to abort.`;

      const confirmKb = new InlineKeyboard()
        .text("✅ Confirm", "wd:mkdir:yes")
        .text("❌ Don't Confirm", "wd:mkdir:no")
        .row()
        .text("🔙 Cancel", "wd:mkdir:cancel");

      await ctx.reply(confirmText, {
        parse_mode: "HTML",
        reply_markup: confirmKb,
      });
      return;
    }

    const num = Number.parseInt(text, 10);
    if (num >= 1 && text === String(num)) {
      const entry = lastSessions.get(chatId);
      if (entry && num <= entry.sessions.length) {
        const target = entry.sessions[num - 1];
        mimo.setSession(chatId, target.id);
        await ctx.reply(
          `Switched to session:\n<code>${target.id}</code>\n${target.title}`,
          { parse_mode: "HTML" },
        );
        lastSessions.delete(chatId);
        return;
      }
    }

    await runMimoCommand(ctx, text, { logPrefix: "chat" });
  });

  // ── callback_query handler ────────────────────────────
  bot.on("callback_query:data", async (ctx) => {
    if (!checkAuth(ctx, config)) {
      await ctx.answerCallbackQuery({
        text: "Access denied.",
        show_alert: true,
      });
      return;
    }

    const chatId = String(ctx.chat?.id);
    const data = ctx.callbackQuery.data;

    if (data.startsWith("wd:")) {
      const parts = data.split(":");
      const action = parts[1];
      const current = browsingPaths.get(chatId) ?? mimo.getWorkDir();

      if (action === "close") {
        await ctx.answerCallbackQuery();
        browsingPaths.delete(chatId);
        browsingSubdirs.delete(chatId);
        try {
          await ctx.deleteMessage();
        } catch {
          await ctx.editMessageText("<i>Explorer closed.</i>", {
            parse_mode: "HTML",
          });
        }
        return;
      }

      if (action === "newfolder") {
        await ctx.answerCallbackQuery();
        waitingForFolderName.set(chatId, {
          parentPath: current,
          ts: Date.now(),
        });
        pendingFolderName.delete(chatId);

        const promptText =
          `<b>📝 Create New Folder Here</b>\n\n` +
          `Parent Path:\n<code>${current}</code>\n\n` +
          `Please reply with a valid folder name (e.g., <code>my-project</code>).`;

        const cancelKb = new InlineKeyboard().text(
          "🔙 Cancel",
          "wd:mkdir:cancel",
        );
        try {
          await ctx.editMessageText(promptText, {
            parse_mode: "HTML",
            reply_markup: cancelKb,
          });
        } catch {
          await ctx.reply(promptText, {
            parse_mode: "HTML",
            reply_markup: cancelKb,
          });
        }
        return;
      }

      if (action === "mkdir") {
        const arg = parts[2];
        const waitEntry = waitingForFolderName.get(chatId);
        const parentPath = waitEntry?.parentPath;
        const folderName = pendingFolderName.get(chatId);

        if (arg === "cancel") {
          await ctx.answerCallbackQuery();
          waitingForFolderName.delete(chatId);
          pendingFolderName.delete(chatId);
          await renderExplorer(ctx, chatId, true);
          return;
        }

        if (arg === "no") {
          await ctx.answerCallbackQuery();
          pendingFolderName.delete(chatId);
          // Re-prompt folder name input
          const promptText =
            `<b>📝 Create New Folder Here</b>\n\n` +
            `Parent Path:\n<code>${current}</code>\n\n` +
            `Please reply with a valid folder name (e.g., <code>my-project</code>).`;

          const cancelKb = new InlineKeyboard().text(
            "🔙 Cancel",
            "wd:mkdir:cancel",
          );
          try {
            await ctx.editMessageText(promptText, {
              parse_mode: "HTML",
              reply_markup: cancelKb,
            });
          } catch {
            await ctx.reply(promptText, {
              parse_mode: "HTML",
              reply_markup: cancelKb,
            });
          }
          return;
        }

        if (arg === "yes") {
          if (!parentPath || !folderName) {
            await ctx.answerCallbackQuery({
              text: "Session state missing.",
              show_alert: true,
            });
            return;
          }

          const targetPath = path.resolve(parentPath, folderName);

          try {
            // F3: guard mkdir target inside workspace root BEFORE writing
            if (!isInsideRoot(targetPath, config.workdirRoot)) {
              await ctx.answerCallbackQuery({
                text: "Cannot create a folder outside the workspace root.",
                show_alert: true,
              });
              waitingForFolderName.delete(chatId);
              pendingFolderName.delete(chatId);
              await renderExplorer(ctx, chatId, true);
              return;
            }

            // F3: re-validate at write time
            if (folderName === "." || folderName === "..") {
              await ctx.answerCallbackQuery({
                text: "Invalid folder name.",
                show_alert: true,
              });
              return;
            }

            fs.mkdirSync(targetPath, { recursive: true });
            await ctx.answerCallbackQuery({
              text: `Folder created: ${folderName}`,
            });

            waitingForFolderName.delete(chatId);
            pendingFolderName.delete(chatId);

            // Update active browsing path to the newly created folder
            const nextNav = isInsideRoot(targetPath, config.workdirRoot)
              ? targetPath
              : config.workdirRoot;
            browsingPaths.set(chatId, nextNav);
            await renderExplorer(ctx, chatId, true);
          } catch (err) {
            await ctx.answerCallbackQuery({
              text: `Failed to create folder: ${(err as Error).message}`,
              show_alert: true,
            });
          }
          return;
        }
      }

      if (action === "sel") {
        await ctx.answerCallbackQuery();
        // F2: guard setWorkDir to stay inside workspace root
        if (!isInsideRoot(current, config.workdirRoot)) {
          await ctx.answerCallbackQuery({
            text: "Cannot select a directory outside the workspace root.",
            show_alert: true,
          });
          return;
        }
        mimo.setWorkDir(current);
        browsingPaths.delete(chatId);
        browsingSubdirs.delete(chatId);

        const text = `✅ <b>Working directory updated to:</b>\n<code>${current}</code>`;
        try {
          await ctx.editMessageText(text, { parse_mode: "HTML" });
        } catch {
          await ctx.reply(text, { parse_mode: "HTML" });
        }
        return;
      }

      if (action === "nav") {
        const arg = parts[2];
        let nextPath = current;
        if (arg === "up") {
          nextPath = path.resolve(current, "..");
        } else {
          const index = Number.parseInt(arg, 10);
          const subdirs = browsingSubdirs.get(chatId) ?? [];
          const folder = subdirs[index];
          if (folder) {
            nextPath = path.resolve(current, folder);
          } else {
            await ctx.answerCallbackQuery({
              text: "Folder not found.",
              show_alert: true,
            });
            return;
          }
        }

        // F1: boundary check BEFORE filesystem access
        if (!isInsideRoot(nextPath, config.workdirRoot)) {
          await ctx.answerCallbackQuery({
            text: "Navigation outside workspace is not allowed.",
            show_alert: true,
          });
          return;
        }

        try {
          fs.accessSync(nextPath, fs.constants.R_OK);
          browsingPaths.set(chatId, nextPath);
          await ctx.answerCallbackQuery();
          await renderExplorer(ctx, chatId, true);
        } catch (err) {
          await ctx.answerCallbackQuery({
            text: `Cannot access folder: ${(err as Error).message}`,
            show_alert: true,
          });
        }
        return;
      }
    }
  });

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  return bot;
}
