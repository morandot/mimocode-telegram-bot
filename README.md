# MiMoCode Telegram Bot

Telegram bot client for [MiMoCode](https://mimo.xiaomi.com/mimocode) — control your AI coding agent from your phone.

## How It Works

The bot spawns a local `mimo serve` (or connects to an existing one via `MIMO_API_URL`) and talks to it over HTTP + SSE:

- Every chat message becomes a session prompt; results stream back as events and are formatted for Telegram.
- **Permission requests arrive as inline buttons** (✅ allow once / ⚡ always allow / ❌ reject) unless `MIMO_SKIP_PERMISSIONS=true`.
- Sessions persist server-side (SQLite), so they survive bot and server restarts.

## Security

This bot lets whitelisted Telegram users drive a coding agent on your host. You **MUST** set `TELEGRAM_ALLOWED_USER_ID` — the bot refuses to start without it.

- `MIMO_SKIP_PERMISSIONS=false` (default): every permission request is sent to Telegram for approval.
- `MIMO_SKIP_PERMISSIONS=true`: all requests auto-approved (like `--dangerously-skip-permissions`). Only use on a disposable/trusted host.

Never share your bot token. The bot binds `mimo serve` to loopback only; set `MIMOCODE_SERVER_PASSWORD` if you bind it elsewhere.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18 or [Bun](https://bun.sh/)
- [MiMoCode](https://mimo.xiaomi.com/mimocode/install) installed (`npm install -g @mimo-ai/cli`, v0.1.7+)
- A Telegram Bot Token (get from [@BotFather](https://t.me/BotFather))

### 1. Get Your Telegram Bot Token

1. Open Telegram, search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Follow the prompts to name your bot
4. Copy the token (looks like `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`)

### 2. Get Your Telegram User ID

1. Open Telegram, search for [@userinfobot](https://t.me/userinfobot)
2. Send any message
3. Copy your numeric User ID

### 3. Install & Run

```bash
git clone https://github.com/morandot/mimocode-telegram-bot.git
cd mimocode-telegram-bot
bun install
cp .env.example .env
# Edit .env with your tokens
bun run start
```

The bot starts `mimo serve` automatically on startup (default port 4096) and shuts it down on exit.

### 4. Configuration

Create a `.env` file:

```bash
# Required
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
TELEGRAM_ALLOWED_USER_ID=123456789

# Optional
MIMO_WORK_DIR=/path/to/your/project
MIMO_SERVE_PORT=4096
MIMO_API_URL=http://127.0.0.1:4096   # connect to an existing server instead
MIMO_SKIP_PERMISSIONS=false          # true → auto-approve everything (dangerous)
```

### 5. Start Chatting

1. Open Telegram and search for your bot
2. Send `/start`
3. Send any message to chat with MiMoCode

## Usage

### Basic Chat

Send a message and MiMoCode responds:

```
You: Fix the bug in src/utils.ts line 42
Bot: [analyzes and fixes the bug]
```

### Permission Approvals

When the agent needs to run a command or write a file, the bot asks right in the chat:

```
🔐 权限请求: bash (npm install)
[✅ 允许一次] [⚡ 总是允许] [❌ 拒绝]
```

### Switch Agents

```
/use            # List agents
/use plan       # Read-only analysis
/use compose    # Full workflow: plan → code → test → review
/compose Build a REST API with auth
```

### Switch Model

```
/model                          # Show current model
/model xiaomi/mimo-v2.5-pro     # Switch model
```

### Session Management

```
/new          # Start fresh session
/sessions     # List all sessions (reply a number to switch)
/delete       # Delete current session
/cancel       # Stop the running task
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Show help & quick actions |
| `/help` | Show all commands |
| `/new` | Start a new session |
| `/cancel` | Stop running task |
| `/workdir` | Browse and change workspace directory (restarts the server) |
| `/status` | Connection & session info |
| `/sessions` | List all sessions (reply number to switch) |
| `/model` | Switch model |
| `/use` | Switch agent (build/plan/compose) |
| `/compose` | Run compose mode workflow |
| `/max` | Run with max parallel sampling |
| `/think` | Run with thinking mode enabled |
| `/delete` | Delete a session |
| `/version` | MimoCode version |

## Development

```bash
bun install
bun run lint        # Biome check
bun run typecheck   # Type check
bun test            # Unit tests (fake server)
bun tests/integration.ts   # Integration vs a real mimo serve
bun run build       # Build for production
```

## License

MIT
