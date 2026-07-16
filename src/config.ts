import { resolve } from "node:path";

export function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env: ${key}`);
  return val;
}

export function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw === "true" || raw === "1";
}

export type Verbosity = "full" | "brief" | "hint" | "off";

export function envVerbosity(key: string, fallback: Verbosity): Verbosity {
  const raw = process.env[key];
  if (!raw) return fallback;
  const valid = ["full", "brief", "hint", "off"] as const;
  if ((valid as readonly string[]).includes(raw)) return raw as Verbosity;
  console.warn(
    `${key}=${raw} is invalid; using ${fallback}. Valid: ${valid.join(", ")}`,
  );
  return fallback;
}

export type Config = {
  readonly telegramToken: string;
  readonly allowedUserIds: readonly string[];
  readonly mimoWorkDir: string;
  readonly workdirRoot: string;
  readonly workdirBrowseEnabled: boolean;
  readonly mimoApiUrl?: string;
  readonly skipPermissions: boolean;
  /**
   * Wall-clock timeout (ms) for a single `mimo run` invoked via sendMessage.
   * 0 disables the timeout. Default 300000 (5 min) guards against hung
   * processes (provider stalls, infinite loops) that would otherwise sit in
   * memory until the user manually /cancel's.
   */
  readonly runTimeoutMs: number;
  readonly showText: Verbosity;
  readonly showReasoning: Verbosity;
  readonly showToolUse: Verbosity;
  readonly showStepStart: Verbosity;
  readonly showStepFinish: Verbosity;
};

export function loadConfig(): Config {
  const allowedRaw = env("TELEGRAM_ALLOWED_USER_ID", "");
  const allowedUserIds = allowedRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowedUserIds.length === 0) {
    throw new Error(
      "TELEGRAM_ALLOWED_USER_ID is empty. Refusing to start: an empty whitelist would let anyone drive your local agent. Set at least one Telegram numeric user ID (get yours from @userinfobot).",
    );
  }

  const runTimeoutMsRaw = process.env.MIMO_RUN_TIMEOUT_MS;
  const runTimeoutMsTrimmed = runTimeoutMsRaw?.trim();
  // Treat unset/empty as the default. Use Number on the trimmed value so
  // whitespace-only input doesn't silently coerce to 0 (= disabled).
  const runTimeoutMs =
    runTimeoutMsTrimmed === undefined || runTimeoutMsTrimmed === ""
      ? 300_000
      : Number(runTimeoutMsTrimmed);
  if (
    !Number.isInteger(runTimeoutMs) ||
    runTimeoutMs < 0 ||
    Number.isNaN(runTimeoutMs)
  ) {
    throw new Error(
      `MIMO_RUN_TIMEOUT_MS must be a non-negative integer number of milliseconds (got "${runTimeoutMsRaw}"). Use 0 to disable the timeout.`,
    );
  }

  return {
    telegramToken: env("TELEGRAM_BOT_TOKEN"),
    allowedUserIds,
    mimoWorkDir: env("MIMO_WORK_DIR", resolve(process.cwd())),
    workdirRoot: resolve(
      process.env.MIMO_WORKDIR_ROOT ||
        env("MIMO_WORK_DIR", resolve(process.cwd())),
    ),
    workdirBrowseEnabled: envBool("MIMO_WORKDIR_BROWSE", false),
    mimoApiUrl: process.env.MIMO_API_URL || undefined,
    skipPermissions: envBool("MIMO_SKIP_PERMISSIONS", false),
    runTimeoutMs,
    showText: envVerbosity("MIMO_SHOW_TEXT", "full"),
    showReasoning: envVerbosity("MIMO_SHOW_REASONING", "off"),
    showToolUse: envVerbosity("MIMO_SHOW_TOOL_USE", "off"),
    showStepStart: envVerbosity("MIMO_SHOW_STEP_START", "off"),
    showStepFinish: envVerbosity("MIMO_SHOW_STEP_FINISH", "off"),
  };
}

export function isAllowed(userId: string, config: Config): boolean {
  return config.allowedUserIds.includes(userId);
}
