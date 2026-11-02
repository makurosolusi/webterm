# webterm

A node-based terminal manager: real shells run as draggable xterm terminals ("nodes") on a pan/zoom React Flow canvas. Terminals are persisted server-side and survive a browser refresh — reload the tab and each node re-attaches its PTY and replays its scrollback, so you never lose a running session by reloading. Terminals and CLI agents live in workspaces (name + working directory + layout) that are persisted in a local SQLite database, so your boards survive a server restart, not just a browser reload. The canvas has a left-edge dock (add nodes, undo/redo, viewport navigation, fit view, zoom, view lock, sessions panel, clean view), a status-colored minimap, and resizable nodes whose size is saved with the workspace. Agent nodes (Claude/Codex/Gemini) can be wired together with context-link edges — a linked node reads a peer's transcript or terminal read-only — and each agent node has an AI "name with AI" button that titles the node from its terminal output.

UI chrome is built on `@vscode-elements/react-elements` 2.4.0 with a `--vscode` theme bridge, so it follows VS Code Dark Modern and Light Modern: a 35px title/menu bar, 35px editor tabs, 48px activity bar, 22px status bar, docked 300px Sessions sidebar, VS Code-style Settings, QuickPick command palette, and Inbox/Chat as tabs of one bottom panel. Tailwind v4 utilities remain for layout and local styling, and the canvas, xterm, Monaco, node geometry, and React Flow interactions stay custom. The chrome is VS Code-like, not a claim of full pixel parity.

## Requirements

- [Bun](https://bun.sh) — runs the dev server and the Bun-native PTY backend.
- Node tooling — for the vitest suite and the TypeScript typecheck.

Install dependencies:

```sh
bun install   # or: npm install
```

## Run (dev)

```sh
bun run dev
```

Serves http://127.0.0.1:8700.

Environment variables:

- `PORT` — listen port (default `8700`).
- `HOST` — bind address (default `127.0.0.1`); `WEBTERM_HOST` is an accepted fallback.
- `WEBTERM_TOKEN` — shared secret required on `/api` and the `/ws` upgrade. Optional on a loopback bind; **mandatory** when `WEBTERM_HOST` is reachable from other machines. The server refuses to start without it rather than expose an unauthenticated shell. The repo does not ship a token in `.env`. Export it explicitly.
- `NODE_ENV` — defaults to dev; set `production` to serve the built `dist/` statically.
- `WEBTERM_DATA_DIR` — data directory for the SQLite store (`webterm.db`), default `~/.webterm-server`.
- `WEBTERM_LEDGER` — `off` (default), `shadow`, or `on`. Turns on the SQLite ledger that backs inbox, approvals, and the channel webhook.
- `WEBTERM_ALLOW_LOOPBACK_APPROVAL` — default `0`. Human approvals (`/api/approvals/*`) refuse token-free loopback, because an agent shell on the same machine can also reach it. Set `1` only for a disposable local demo. With a root token configured, the normal token gate applies.
- `WEBTERM_TELEGRAM` — `off` (default) or `on`. Installs `POST /webhooks/telegram` when `WEBTERM_TELEGRAM_WEBHOOK_SECRET` is set and the ledger is on.
- `WEBTERM_TELEGRAM_WEBHOOK_SECRET` — Telegram `secret_token` for the webhook. Keep it in the environment, not in a committed file.
- `WEBTERM_TELEGRAM_BOT_TOKEN` — bot token used for replies. The legacy `TELEGRAM_BOT_TOKEN` name is also accepted.
- `WEBTERM_RUN_REQUIRE_APPROVAL` — default `off`. When `on`, `POST /api/orchestrator/run` requires an approved ledger `approvalId` + `approvalDigest`; when the fields are supplied (even with the flag off) they are consumed exactly once before any worktree or PTY work.
- `WEBTERM_CENTRAL_AUTONOMY` — default `off`. When `on` (with ledger and `WEBTERM_ORCHESTRATOR_RUN=on`), a 30 s scheduler runs one lowest-seq `assigned` plan item per tick through the same run route, skips paused projects/closed plans, and quarantines a project after 3 consecutive failures. It never creates tasks or approves approvals.
- `WEBTERM_CENTRAL_CHAT` — default `off`. Exposes the central chat API/SSE and web panel when `WEBTERM_CENTRAL=on`.
- `WEBTERM_CENTRAL_RUNTIME` — default `off`; `mock` or primary `opencode`. The OpenCode adapter runs `opencode run --format json` without PTY or `--auto`.
- `WEBTERM_CENTRAL_MODEL` — default `opencode/deepseek-v4.1-flash-free`; use a credentialed provider for sustained turns. Free quota may return `provider.quota` 429 and is not retried.
- `WEBTERM_OPENCODE_BIN` — default `opencode`; override the OpenCode binary path.
- `WEBTERM_CENTRAL_TOOLS` — default `read`; `write` enables the four-tool typed proposal MVP: `goal.propose`, `plan.propose`, `task.assign`, and `approval.request`.
- `WEBTERM_CENTRAL_PLANNER` — default `off`; typed proposal handling requires this flag `on` and `WEBTERM_CENTRAL_TOOLS=write`. `task.assign` also requires `WEBTERM_ORCHESTRATOR_RUN=on` and creates/locks a real ledger task without spawning, running, or approving it.
- `WEBTERM_CENTRAL_TELEGRAM` — default `off`; enables the private Telegram central chat bridge. Real Telegram delivery/webhook E2E is not verified.
- `WEBTERM_CENTRAL_MEMORY` — default `off`; bounded, read-only project fact retrieval. It does not write or promote memory. Proposal blocks render as compact cards and do not claim applied or approved status.

Any of these can go in a `.env` file in the working directory instead of the environment. Bun loads that file automatically, for both the dev server and the compiled binary, so every value in it enters `process.env`. Keep the file at mode `600`, and leave `WEBTERM_TOKEN` out of it unless you accept that inheritance.

`WEBTERM_CHANNELS` is the master kill switch for the whole channel runtime (webhook, binding API, reply sender). Only `on|off` is implemented: unset or `on` keeps the current behavior, `off` disables everything even when `WEBTERM_TELEGRAM=on`, and any other value fails closed (channels stay off) with one warning naming the supported values. The `readonly|control` modes remain planned. Channel state lives in a JSON store under the data directory, so enabling channels needs no v4 SQL migration.

Dev is not full browser HMR for every change: Vite HMR covers client edits live, but server edits need a restart.

## Logs and the Output panel

The server records structured, tagged log entries (PTY and agent lifecycle, workspaces, filesystem, settings, hooks, approvals, channels, ledger, HTTP errors, auth rejections, WebSocket connects) into an in-memory ring buffer, mirrors them to the console, and by default writes them to a daily file. Browser errors (uncaught errors, unhandled rejections, failed API calls) are reported back to the same log as the `client` channel.

Open the **Output** panel from the status bar (the error/warning counters on the right), **View > Output** in the menu bar, the command palette (`View: Toggle Output`, `Output: Clear Output`, `Output: Set Log Level…`), or `Shift+Cmd+U` (macOS) / `Ctrl+Shift+U`. The panel has a channel dropdown, a Log Level selector, a filter box, Clear, auto-scroll lock, Copy All, and Save As.

Levels: `trace`, `debug`, `info` (default), `warn`, `error`. Entries below the active level are dropped, and there is no `off`. Environment variables, read once at boot (restart to change):

- `WEBTERM_LOG_LEVEL` — starting level. The panel can change it at runtime without a restart.
- `WEBTERM_LOG_BUFFER` — entries kept in memory (100 to 100000, default `5000`).
- `WEBTERM_LOG_FILE` — `on` (default) or `off`. When on, entries are appended as JSON lines to `<WEBTERM_DATA_DIR>/logs/webterm-YYYY-MM-DD.log`, rotated by day and at 5 MiB, keeping at most 7 files.

Endpoints, all behind the root-token gate (open on loopback without a token, like `/api/settings`; per-node agent tokens are refused):

- `GET /api/logs` — recent entries; filters `level`, `channel`, `q`, `afterSeq`, `limit` (default 1000, max 2000).
- `GET /api/logs/stream` — Server-Sent Events with replay from `afterSeq` / `Last-Event-ID`.
- `PUT /api/logs/level` — body `{"level":"warn"}`.
- `POST /api/logs/client` — browser-reported entries (up to 20 per request, 32 KiB body, 200 entries per minute).
- `DELETE /api/logs` — clear the buffer (the log file is untouched).

Not logged: terminal input or output, message text (chat, Telegram), env or secret values, URL query strings, request bodies and headers, and personal data such as emails or raw chat ids. Fields whose names look like secrets (password, token, api key, cookie, ...) are masked, and a URL path id is shown as `:id`. Workspace names and full file paths are not recorded either (fs events carry only a basename and a size).

## Build / production

```sh
vite build                                   # emits dist/
NODE_ENV=production bun src/server/index.ts  # serve dist/ from disk
```

Or compile a single self-contained executable that needs no `dist/` beside it — the built assets are embedded into the binary:

```sh
bun run build:binary   # emits ./webterm
./webterm              # runs from any directory; reads HOST / PORT (and a .env) from the cwd
```

## Tests

Split by runtime:

- `TMPDIR=/tmp/st npm run typecheck` — `tsc --noEmit` typecheck gate.
- `TMPDIR=/tmp/st npm run test` — vitest. Node environment by default; the suites that mount the real canvas select jsdom per file through the `@vitest-environment` pragma.
- `TMPDIR=/tmp/st bun test src/server/*.bun.test.ts` — every Bun-only suite (PTY round-trip / detach / scrollback replay, SQLite workspace store, workspaces API, fs operations, git info), all of which need a real PTY or `bun:sqlite` and are excluded from vitest. A glob, not a list of names: an enumerated list goes stale the moment a file is added, and goes stale without ever turning red.

The `TMPDIR` prefix is not optional on macOS: the tests bind unix sockets under `$TMPDIR`, and the default path blows past the 104-character `sun_path` limit, failing with `EINVAL`.

The vitest run now also covers `src/shared` (assembleCmd / agent config).

## How it works

`src/server/index.ts` runs a single `node:http` server on one port: in dev it mounts Vite in middleware mode (HMR on that same port), and in production it serves the built `dist/`. A `ws` WebSocketServer on `/ws` multiplexes every terminal over one shared socket, keyed by a stable client-generated id. The server keeps each PTY alive across socket close (detach) and replays a 256 KB scrollback ring buffer on re-attach; a PTY dies only on explicit close or when the shell exits. PTYs are Bun-native (`Bun.spawn` with its inline `terminal` option), with no node-pty dependency.

Workspaces + layout are persisted in `bun:sqlite` (`src/server/db.ts`) as the source of truth, served over a small REST API under `/api` (`src/server/api.ts`); a node may be a terminal or an agent — an agent node spawns a CLI command via the login shell (`cmd` on the open message) instead of an interactive shell. PTYs remain in-memory, so a server restart reloads workspace + node definitions from the DB and respawns fresh PTYs.

Live agent status comes from Claude hooks, delivered as a settings file (`claude --settings <path>`) rather than an inline blob, that POST each lifecycle event to `/api/agent-status`; the server maps those events to working/waiting/blocked/done and broadcasts them over the WebSocket as a `StatusMsg`. A pre-set session UUID (`--session-id`) lets a finished Claude session be continued with `--resume`. The Board is a read-only client overlay over the same node data, and the folder picker is served by `GET /api/fs`.

With `WEBTERM_LEDGER` on, the server also exposes read-only inbox, memory, and orchestrator projections, plus a human approval surface under `/api/approvals/*`. That surface is not capability-authorized. It needs the root token, or an explicit loopback opt-in, and it never lets an agent approve its own action. The P3-P5 work behind these routes is still partial. Central proposal MVP, Telegram bridge logic, and memory retrieval have additional limits documented in `RND/14-CENTRAL-AGENT-S0.md`.

Agent nodes can be linked with context-link edges (persisted as workspace bridges); a linked node reads a bridged peer read-only over `GET /api/context-link` (verbs `list` / `summary` / `transcript` / `terminal`), fed by a POSIX-sh shim the server installs under the data dir. The sparkle button calls `GET /api/generate-name`, which spawns the `claude` CLI in print mode on a node's terminal buffer and returns a short Title-Case title. Live-view broadcast is intentionally absent — webterm's single-user loopback has no viewer or relay, mirroring nodeterm's Server Edition.
