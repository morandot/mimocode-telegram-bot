# Changelog

## 0.3.0 - 2026-08-07

### Breaking Changes

- Architecture migration: the bot no longer spawns a `mimo run` process per message. It now manages a persistent `mimo serve` subprocess and talks to it over HTTP + SSE. Sessions persist server-side (SQLite) and survive bot/server restarts.
- Removed CLI-only commands: `/models`, `/stats`, `/export`, `/providers` (no server API equivalent in the new architecture).
- `MIMO_API_URL` semantics changed: it now connects to an existing `mimo serve` instead of attaching `mimo run` to a remote server.

### Features

- Persistent `mimo serve` (managed subprocess): spawn, health-check, auto-restart on crash, graceful shutdown; `MIMO_SERVE_PORT` configures the port (default 4096).
- Interactive permission approval: permission requests arrive as Telegram inline buttons (✅ allow once / ⚡ always allow / ❌ reject) instead of being silently rejected or fully auto-approved; CSPRNG tokens with TTL cleanup.
- `/cancel` aborts via the server API with a race-window guard (a cancel landing during session creation is honoured instead of starting the task).
- `/workdir` switches restart the managed server; sessions persist across the switch.
- `/use` lists agents dynamically from the server; `/status` shows server URL, version, and permission mode.
- Model/provider errors (e.g. unsupported model, quota) are surfaced to the user instead of returning an empty reply.
- Stale session recovery handles both 404 responses and the serve < v0.1.10 200-with-empty-body response.
- `/new` and `/delete` tolerate already-deleted (stale) sessions.

### Fixes

- Prompt response parts are now the authoritative content source, with SSE-accumulated text as fallback — content is returned even without an SSE subscription.
- Fixed `/workdir` failure feedback (double callback answer swallowed the error alert).
- Permission tokens switched to CSPRNG; HTML-escaped permission strings; failed replies keep the button alive for retry.

### Tests

- 198 unit tests against a fake HTTP + SSE server (session CRUD, prompt params, SSE event conversion, stale-session recovery, timeouts, cancel races, permission routing).
- 13/13 integration tests against a real `mimo serve`, including a live model round-trip.
