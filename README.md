# webterm

A node-based terminal manager: real shells run as draggable xterm terminals ("nodes") on a pan/zoom React Flow canvas. Terminals are persisted server-side and survive a browser refresh — reload the tab and each node re-attaches its PTY and replays its scrollback, so you never lose a running session by reloading. Terminals and CLI agents live in workspaces (name + working directory + layout) that are persisted in a local SQLite database, so your boards survive a server restart, not just a browser reload. The canvas has a left-edge dock (add nodes, undo/redo, viewport navigation, fit view, zoom, view lock, sessions panel, clean view), a status-colored minimap, and resizable nodes whose size is saved with the workspace. Claude Code agent nodes can be wired together with context-link edges — a linked node reads a peer's transcript or terminal read-only — and each agent node has an AI "name with AI" button that titles the node from its terminal output.

UI chrome is built on `@vscode-elements/react-elements` 2.4.0 with a `--vscode` theme bridge, so it follows VS Code Dark Modern and Light Modern: a 35px title/menu bar, 35px editor tabs, 48px activity bar, 22px status bar, docked 300px Sessions sidebar, VS Code-style Settings, QuickPick command palette, Problems/Activity/Output as tabs of one bottom panel, and the Central chat in a secondary side bar on the right, where a Needs-you strip (which replaces the old Inbox panel) lists approvals, reviews and broken tasks. Tailwind v4 utilities remain for layout and local styling, and the canvas, xterm, Monaco, node geometry, and React Flow interactions stay custom. The chrome is VS Code-like, not a claim of full pixel parity.

## Requirements

- [Bun](https://bun.sh) — runs the dev server and the Bun-native PTY backend.
- Node tooling — for the vitest suite and the TypeScript typecheck.
- [tmux](https://github.com/tmux/tmux) (optional) — keeps terminal and agent sessions alive across a server restart. Without it, sessions end when the server restarts, and Doctor warns.

Install dependencies:

```sh
bun install   # or: npm install
```

## Run (dev)

```sh
bun run dev
```

Serves http://127.0.0.1:8700.

Features are switched in Settings > **Capabilities**: seven cards (Central Agent, Worker orchestrator, Central Agent autonomy, Browser on canvas, Files, Edit and upload files, Telegram), each one on/off switch that applies immediately, with no restart, plus an **Automation token** card (enable or rotate the root token used by scripts and agents; no switch). A capability also turns on what it needs: workers need Central, autonomy needs workers, file writes need file viewing. The per-feature variables below are no longer the main path; they are still read as legacy input (a child key whose parent capability is off is ignored, with one warning per key). Changing settings or capabilities needs the signed-in webterm page (see [Signing in](#signing-in)); scripts send the root token in `x-webterm-token`. Design and limits: `docs/decisions/envsimple.md`; changes: `docs/changelog/envsimple.md`.

Environment variables:

- `PORT` — listen port (default `8700`); a bad value aborts startup.
- `WEBTERM_PROXY_PORT` — port of the separate-origin dev-server proxy (`/proxy/<port>`), default `PORT+1` on the same host; if it is busy the OS picks one. Read once at boot.
- `HOST` — bind address (default `127.0.0.1`); `WEBTERM_HOST` is an accepted fallback.
- `WEBTERM_TOKEN` — the root access token, required on `/api` and `/ws` on every bind, loopback included. Without this variable, webterm reads `<data dir>/secrets/WEBTERM_TOKEN` (mode `600`) or generates it there on first start; a TTY prints the file path, never the value. Scripts send it in the `x-webterm-token` header; it is never accepted in a URL query. Rotate it from Settings > Capabilities > Automation token, which signs every other browser out. The `/ws` and `/ws/browser` WebSockets on the browser cookie also need the page's same-origin `Origin` header; clients without one get `403 origin_required`.
- `NODE_ENV` — defaults to dev; set `production` to serve the built `dist/` statically.
- `WEBTERM_DATA_DIR` — data directory for the SQLite store (`webterm.db`), default `~/.webterm-server`. It also holds the `webterm` CLI (`bin/webterm`) and the Claude provider settings (`claude-provider/`, mode `600`). Ledger migrations (up to v22) run automatically on start.
- `WEBTERM_AGENT_SANDBOX` — default `on`. Claude agents run shell commands in the Claude Code sandbox (macOS), so they cannot read webterm secrets or other nodes' tokens. Applies on the next agent launch; also in Settings > Control.
- `WEBTERM_LEDGER_SHADOW` — set `1` to run the SQLite ledger (inbox, approvals, channel webhook) in shadow mode, where a failed open does not stop the server. The ledger itself is always on; `WEBTERM_LEDGER` is ignored.
- Human approvals (`/api/approvals/*`) and token rotate need no configuration: they are accepted only from the signed-in webterm page (its `wt_ui` cookie plus `Sec-Fetch-Site: same-origin` and a same-origin `Origin`), and an agent credential (node token or capability) is refused with `403 agent_cannot_approve`. See `docs/decisions/ui-session-cookie.md`.
- `WEBTERM_TELEGRAM` — the Telegram capability switch. Normally set by pasting a bot token in the Telegram card (the token is verified with Telegram first). Polling is the default; `POST /webhooks/telegram` is installed only with `WEBTERM_TELEGRAM_MODE=webhook`.
- `WEBTERM_TELEGRAM_WEBHOOK_SECRET` — optional override of the webhook `secret_token`; generated into `<data dir>/secrets/` when absent. Keep it out of committed files.
- `WEBTERM_TELEGRAM_BOT_TOKEN` — optional override of the bot token used for replies. The legacy `TELEGRAM_BOT_TOKEN` name is deprecated.
- `WEBTERM_RUN_REQUIRE_APPROVAL` — default `on` when Worker orchestrator is enabled (a sub-option of that card). When `on`, `POST /api/orchestrator/run` requires an approved ledger `approvalId` + `approvalDigest`; when the fields are supplied (even with the flag off) they are consumed exactly once before any worktree or PTY work.
- `WEBTERM_CENTRAL_AUTONOMY` — default `off`. When `on` (with ledger and `WEBTERM_ORCHESTRATOR_RUN=on`), a 30 s scheduler runs one lowest-seq `assigned` plan item per tick through the same run route, skips paused projects/closed plans, and quarantines a project after 3 consecutive failures. It never creates tasks or approves approvals.
- `WEBTERM_CENTRAL_CHAT` — derived from Central Agent (default `off`). Exposes the central chat API/SSE and web panel when `WEBTERM_CENTRAL=on`.
- `WEBTERM_CENTRAL_RUNTIME` — Central runs on Claude only. Unset = auto-detect: `claude` if the Central launch profile's command is on PATH, else `off` (Central then asks you to set up Claude in Settings › Agent › Claude launch profiles); it never falls back to `mock` (that is only used when set explicitly). A legacy `opencode` or `codex` value means automatic. Settings shows the engine status with "Check again". `GET /api/central/health` returns `{ runtime, chat, ledger, runtimeReady }`; when the `claude` runtime is not ready it adds `runtimeIssue` (`claude_not_found|claude_not_authenticated|claude_check_failed`).
- `WEBTERM_CENTRAL_MODEL` — empty = the runtime's default; a Claude alias or model id.
- `WEBTERM_CENTRAL_TOOLS` — default `read`; the Worker orchestrator card sets `write` (an explicit `.env`/shell value still wins). `write` enables the four-tool typed proposal MVP: `goal.propose`, `plan.propose`, `task.assign`, and `approval.request`.
- `WEBTERM_CENTRAL_PLANNER` — default `off`; set `on` by the Worker orchestrator card (an explicit `.env`/shell value still wins). Typed proposal handling requires this flag `on` and `WEBTERM_CENTRAL_TOOLS=write`. `task.assign` also requires `WEBTERM_ORCHESTRATOR_RUN=on` and creates/locks a real ledger task without spawning, running, or approving it.
- `WEBTERM_CENTRAL_TELEGRAM` — derived: on while both Central Agent and Telegram are on; enables the private Telegram central chat bridge (works with the `claude` runtime). Real Telegram delivery/webhook E2E is not verified.
- `WEBTERM_CENTRAL_MEMORY` — default `off`; bounded, read-only project fact retrieval. It does not write or promote memory. Proposal blocks render as compact cards and do not claim applied or approved status.
- Central Agent v2 flags (all default `off`/safe, need the always-on ledger; not listed in Settings): `WEBTERM_CENTRAL_AGENTS` (`off|propose|auto`, also the ceiling for the control level; the Worker orchestrator card sets `propose` and Central Agent autonomy sets `auto`, an explicit `.env`/shell value still wins; without a stored global level the effective level is the ceiling capped at `act_gated`, so `act_envelope` always needs a human to raise it), `WEBTERM_CENTRAL_READ_TOOLS`, `WEBTERM_CENTRAL_CHECKPOINT`, `WEBTERM_CENTRAL_SKILLS`, `WEBTERM_CENTRAL_SKILL_PROPOSE`, `WEBTERM_AGENT_MAIL`, `WEBTERM_KNOWLEDGE`, `WEBTERM_CENTRAL_BOTS`, `WEBTERM_CHANNEL_APPROVAL_BUTTONS`, `WEBTERM_CENTRAL_RELIABILITY`, plus limits `WEBTERM_CENTRAL_MAX_STEPS`, `WEBTERM_CENTRAL_TURN_STEPS`, `WEBTERM_CENTRAL_TURN_WALL_MS`, `WEBTERM_CENTRAL_DAILY_TOKENS`, `WEBTERM_CENTRAL_DAILY_SPAWNS`, `WEBTERM_CENTRAL_DAILY_COST_MICROS`, `WEBTERM_CENTRAL_CONTEXT_WINDOW`, `WEBTERM_CENTRAL_MAX_INFLIGHT`, `WEBTERM_AGENT_IDLE_DONE_MS`.
- Central control endpoints (root credential, mounted only when a v2 flag is armed): `GET /api/central/status|agents|approvals|skills|memory`, `GET|PUT /api/central/control`, `POST /api/central/halt` (kill switch), `POST /api/central/agents/:id/relay|close`, `POST /api/central/skills/:id/approve|rollback`. The UI panel shows when `WEBTERM_CENTRAL_CHAT` is on.
- `WEBTERM_FILES_MUTATE` — default `off`. Enables delete (to trash, with Undo), restore, rename, and copy in files nodes.
- `WEBTERM_FILES_VIEWERS` — default `on`. Enables `GET /api/fs/raw` and the image/audio/video/PDF viewers.
- `WEBTERM_FILES_WATCH` — default `on`. Live directory watching, so listings and open editors follow changes made outside webterm.
- `WEBTERM_FILES_GIT_STATUS` — default `on`. Git status marks (M/A/D/U/R/C) on the file list.
- `WEBTERM_FILES_QUICK_OPEN` — default `on`. File search behind Ctrl/Cmd+P while a files node has focus.
- `WEBTERM_FILES_UPLOAD` — default `off`; derived from Ubah dan unggah file. Upload to and download from files nodes.
- `WEBTERM_FILES_LIST_MAX` — default `5000`. Maximum entries in one directory listing; the rest is cut and marked truncated.
- `WEBTERM_FILES_UPLOAD_MAX_MB` — default `100`. Maximum size of one uploaded file.

- `WEBTERM_BROWSER` — default `off`. `on` enables the Browser node (Chromium on the server, streamed to the canvas). Off means no browser process, proxy, or routes. A real-Chromium test exists (`src/server/browser/chromium.real.bun.test.ts`). See `docs/decisions/browser-canvas.md`.
- `WEBTERM_BROWSER_BIN` — absolute path to Chromium/Chrome; empty auto-detects (well-known macOS apps: Chrome, Chromium, Chrome Canary, Edge, Brave; Linux paths and `PATH`; Playwright cache). A set path that does not exist is reported as invalid and is not replaced by auto-detection. Settings > Capabilities > Advanced lists what was found.
- `WEBTERM_BROWSER_MAX_LIVE` (1 to 8) and `WEBTERM_BROWSER_DISCARD_MS` — live tab cap and how long a hidden node waits before its page is discarded.
- `WEBTERM_BROWSER_AGENT` — default `on`. An agent terminal drives only the Browser nodes wired to it by a cable (edge) on the canvas: the cable is the permission, checked on every call, so wiring or unwiring takes effect without a restart. One cable picks that browser; with several, pass `--node <id>`; with none, the agent is told to ask for a cable. Turn it off with the agent checkbox in the Browser toolbar or the "Let agents drive the browser" sub-option of the Browser card (dangerous; turning it back on asks for confirmation, no restart).
- `WEBTERM_BROWSER_ALLOW_HOSTS` — comma-separated `host:port` private/localhost targets that may be opened; empty blocks all private networks. When webterm binds to loopback, `localhost`, `*.localhost`, and loopback IPs are allowed without listing them (except webterm's own port); other private networks stay blocked. A malformed value disables the feature. Hosts match exactly, so `WEBTERM_BROWSER_ALLOW_HOSTS=localhost:3000` does not cover `127.0.0.1:3000`; list each form you open. A blocked page shows an "Allow host:port" button that adds the entry and reloads, with no restart.
- Opening a Browser node from a link: right-click an `http(s)` link in a terminal or agent node and choose "Open in canvas browser", or drag a URL onto empty canvas. The node appears beside the source (or at the drop point). If a Browser node already shows that URL, you are taken to it instead of a second node opening, and its page is not navigated. While the browser is off, "Open in canvas browser" still shows and offers to turn it on, then opens the link. Cmd/Ctrl+click on a link still opens a normal browser tab, and agents cannot open Browser nodes on their own yet.
- `WEBTERM_BROWSER_HEADLESS` — default `off`. Chromium runs headful (normal user agent, `navigator.webdriver` false) and is streamed over CDP; each Browser node gets its own window, opened in the background without focus: off-screen on Linux/Windows, minimized on macOS (macOS pulls off-screen windows back onto the screen). On macOS a second Chrome icon shows in the Dock while Browser nodes run. `on` forces `--headless=new`, which sites such as Google detect as a bot. Linux without `DISPLAY`/`WAYLAND_DISPLAY` falls back to headless automatically and logs a warning.
- Cookie import from a file is on whenever the Browser node is on: open a Browser node's "⋯" menu, then Import Cookies > From File… (pick a file, preview domains and counts, confirm). Google login cookies (`google.com` and Google's device-bound cookies) are skipped on import, and the preview says how many; sign in to Google directly in the Browser node. `WEBTERM_BROWSER_COOKIE_IMPORT=off` turns it off; `WEBTERM_BROWSER_COOKIE_TTL_DAYS` (default `7`) sets how long imported cookies stay in the encrypted vault.

No `.env` is required: only the bootstrap keys in `.env.example` need the environment; the rest is switched in Settings > Capabilities (a stored value beats the environment). Bun still loads a cwd `.env`, but spawned shells drop its values.

The channel runtime (webhook, binding API, reply sender) follows the Telegram capability: it exists exactly while Telegram is on. `WEBTERM_CHANNELS` is no longer read as a switch; the capability writes it as a derived key, and a legacy `WEBTERM_CHANNELS=on` while Telegram is off is ignored with one warning. The `readonly|control` modes remain planned. Channel state lives in a JSON store under the data directory, so enabling channels needs no v4 SQL migration. To link a Telegram chat to a project, the Telegram card shows a one-time `t.me` deep link (single use, valid 10 minutes); open it and press Start.

The file manager API lives under `/api/fs/<verb>` and uses the same token gate as the rest of `/api`. GET verbs: `list`, `list-v2`, `read`, `read-binary`, `exists`, `stat`, `capabilities`, plus `raw` (needs `WEBTERM_FILES_VIEWERS`), `git-status` (`WEBTERM_FILES_GIT_STATUS`), and `search` (`WEBTERM_FILES_QUICK_OPEN`). POST verbs: `create`, `write`, `mkdir`, plus `delete`, `restore`, `rename`, `copy` (`WEBTERM_FILES_MUTATE`) and `upload` (`WEBTERM_FILES_UPLOAD`). A verb whose flag is off answers `501` with code `EDISABLED`. Design decisions and known limits: `docs/decisions/files-manager.md`.

### Testing a fresh install

```sh
bun run dev:fresh
```

Starts a second, throwaway webterm that behaves like the first run on a machine that never had webterm, next to your normal one (which it never touches). It gets its own temp root (`$TMPDIR/webterm-fresh-*` with its own data dir, `HOME`, `CLAUDE_CONFIG_DIR` and Vite cache), its own port (first free from `8710`; never `8700`/`8701`) and proxy port, and its own tmux socket, so it cannot see or re-adopt your sessions. It drops `WEBTERM_*`, `NODETERM_*`, `TMUX*`, `XDG_*`, `ANTHROPIC_*` and `CLAUDE_CODE_*` from its environment and does not load `.env`. The banner prints the URL, the temp root, a setup hint ("No account yet — open webterm in a browser on this machine to create one, or use the setup code in `<temp root>/data/secrets/SETUP_CODE`") and the active flags. The fresh instance opens on "Create your webterm account" (use "Open setup window on this computer"). Ctrl+C (or closing the terminal) stops it and deletes the temp root, its tmux server and the Claude keychain items of its `CLAUDE_CONFIG_DIR`. A run that ends any other way is cleaned up too: the fresh server notices within ~2 s that `dev:fresh` is gone (even after `kill -9`) and removes itself, and every start first removes the leftovers of runs whose `dev:fresh` process is dead (`<temp root>/owner.json` records it; a root without one counts after an hour). Running instances are never touched.

Flags: `--port <n>`, `--keep` (keep the temp root; cleanup still stops its processes but leaves the files), `--no-claude` (remove every `PATH` directory holding a `claude` executable), `--with-provider-env` (keep `ANTHROPIC_*`/`CLAUDE_CODE_*` and load `.env`), `--clean` (only remove stale leftovers now, list running instances, and exit: `bun run dev:fresh -- --clean`). It still uses this machine's OS, tmux, git and bun, and the same macOS login keychain (Claude Code keys its keychain entry by `CLAUDE_CONFIG_DIR`, so the fresh instance starts signed out; cleanup deletes only the entries for that instance's own `CLAUDE_CONFIG_DIR`).

## Signing in

Nothing to configure. On the first `bun run dev` webterm opens your default browser on a **Create your webterm account** form (username, a password of at least 12 characters): it writes a one-time code (single use, 60 s) into a `600` file in `<data dir>/run/` and opens that file, so the code never appears in a terminal, a URL you share, or `ps`. The browser keeps an HttpOnly `wt_ui` session cookie for 30 days of inactivity. A restart opens nothing; open tabs keep working.

- There is one account, created on first run. Creating it needs proof that you are on the computer running webterm: the window webterm opened (or "Open setup window on this computer"), or, from another device, the setup code in `<data dir>/secrets/SETUP_CODE` ("Setting up from another device?" on the setup screen).
- A signed-out tab asks for the username and password and returns to the page you asked for. "Open signed-in window" still opens a signed-in window on the computer running webterm without a password (at most one per 10 s). Repeated wrong passwords are slowed down (the screen counts down), never locked out.
- Settings > **Account** (`?settings=account`, or the account button in the title bar): change the username or password (a password change signs every other session out), see the browsers signed in to your account and sign any of them out, and Sign out here.
- Forgot the password: run `webterm --reset-password <username>` (see [Command-line options](#command-line-options)).
- The access token no longer signs people in once the account exists: it is the automation token for scripts, MCP clients and agents (Settings > Capabilities > Automation token). A `/?token=` link is ignored then. Rotating the token signs every other browser out.
- Scripts and agents never use the cookie: scripts send the root token in `x-webterm-token`, and agent sessions use their own node token (the `webterm` CLI reads it from the node's header file).

## Agent Chat node

An Agent Chat node runs Claude Code without a terminal and shows it as a chat: streamed Markdown, tool cards, permission prompts (Allow once, Always allow, Deny), questions, plan review, a mode picker, Stop, and the cost of the last turn. It sits next to the terminal agent node, which is unchanged. Add one from the Dock, "Add node" > Agent Chat, the canvas menu, the tab-layout "+" menu, or "Agent Chat: New Agent Chat" in ⌘K. It is offered while Claude is enabled and needs no configuration: it uses the installed `claude`, the node's launch profile and the default permission mode, like a terminal agent; while Settings › Agents › Skip approvals is on (the default), it launches with no permission prompts.

The server owns the Claude process: it starts on the first message, keeps running if the tab closes, closes after 10 idle minutes (the next message resumes the session), and stops when the node or its workspace is deleted. With more than 3 running, the one idle longest is closed (it resumes on its next message); a busy one never is. History comes from Claude's own transcript, so a chat survives a server restart, but a turn running at that moment is cut off. The `/api/agent-chat/*` routes accept only the webterm page, never an agent's node token. Design and limits: `docs/decisions/agent-chat.md`.

## `webterm` CLI

Agent sessions get a `webterm` CLI on `PATH` (written to `<data dir>/bin/webterm` on every boot, plus a `webterm-cli` skill stub under `~/.claude/skills/`). It carries no token; it reads the node's own header file. Commands: `webterm agent-context`, `webterm <tool> --json '{...}'` (a capability call over `/api/tools`), `webterm skills get <name>`, `webterm whats-new [--since <version>]`, `webterm browser ...`, `webterm context ...`, and `webterm eval run [--model fake|real] [--json]`, which replays the eval cases collected from rejected approvals, dismissed memory proposals and checkpoint rewinds (exit 0 all pass, 1 a failure, 2 bad usage). Separately, each Claude Code agent is configured at spawn with a `webterm` stdio MCP server, through webterm-owned files and per-process flags only, never your global CLI config. Other CLIs (Codex, Gemini, OpenCode, …) run as plain programs in a terminal node, with no webterm integration.

Dev is not full browser HMR for every change: Vite HMR covers client edits live, but server edits need a restart.

## Logs and the Output panel

The server records structured, tagged log entries (PTY and agent lifecycle, workspaces, filesystem, settings, hooks, approvals, channels, ledger, HTTP errors, auth rejections, WebSocket connects) into an in-memory ring buffer, mirrors them to the console, and by default writes them to a daily file. Browser errors (uncaught errors, unhandled rejections, failed API calls) are reported back to the same log as the `client` channel.

Open the **Output** panel from the status bar (the error/warning counters on the right), **View > Output** in the menu bar, the command palette (`View: Toggle Output`, `Output: Clear Output`, `Output: Set Log Level…`), or `Shift+Cmd+U` (macOS) / `Ctrl+Shift+U`. The panel has a channel dropdown, a Log Level selector, a filter box, Clear, auto-scroll lock, Copy All, and Save As.

Levels: `trace`, `debug`, `info` (default), `warn`, `error`. Entries below the active level are dropped, and there is no `off`. Environment variables, read once at boot (restart to change):

- `WEBTERM_LOG_LEVEL` — starting level. The panel can change it at runtime without a restart.
- `WEBTERM_LOG_BUFFER` — entries kept in memory (100 to 100000, default `5000`).
- `WEBTERM_LOG_FILE` — `on` (default) or `off`. When on, entries are appended as JSON lines to `<WEBTERM_DATA_DIR>/logs/webterm-YYYY-MM-DD.log`, rotated by day and at 5 MiB, keeping at most 7 files.

Endpoints, all behind the `/api` gate (the signed-in page or the root token, like `/api/settings`; per-node agent tokens are refused):

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

### Command-line options

The server entry (`./webterm` or `bun src/server/index.ts`) handles these before it opens the database or binds a port; with no options it starts the server.

- `-h, --help` — usage, options and the main environment variables.
- `-v, --version` — version and build id.
- `-r, --readme` — this README, built into the binary (paged through `less` on a terminal).
- `-d, --docs [topic]` — list topics (this README's sections plus `env`, the full environment reference), or print one.
- `--reset-password <username>` — set a new password for an account and sign it out everywhere, without starting the server. It asks twice on a terminal (no echo), or reads the first line of stdin. Exit status 0 on success, 1 when the account (or the database) does not exist, 2 on a usage error or a password shorter than 12 characters.

An unknown option prints a suggestion and exits with status 2.

## Tests

Split by runtime:

- `TMPDIR=/tmp/st npm run typecheck` — `tsc --noEmit` typecheck gate.
- `TMPDIR=/tmp/st npm run test` — vitest. Node environment by default; the suites that mount the real canvas select jsdom per file through the `@vitest-environment` pragma. It runs on the `threads` pool (each file still isolated); `src/testDom.setup.ts` unmounts React trees after every jsdom test and raises the `findBy*` timeout to 5 s.
- `TMPDIR=/tmp/st npm run test:related -- <files>` / `npm run test:changed` — the fast loop: only the vitest files that import the given files, or the files touched since the last commit.
- `TMPDIR=/tmp/st npm run test:bun` — every `src/server/**/*.bun.test.ts` suite, subfolders included (PTY round-trip / detach / scrollback replay, SQLite workspace store, ledger, workspaces API, fs operations, git info), all of which need a real PTY or `bun:sqlite` and are excluded from vitest. It runs with `--no-env-file` and a temporary `HOME`; the `*.real.bun.test.ts` real-browser suites run in a second pass. Found with `find`, not a list of names: an enumerated list goes stale the moment a file is added, and goes stale without ever turning red.

The `TMPDIR` prefix is not optional on macOS: the tests bind unix sockets under `$TMPDIR`, and the default path blows past the 104-character `sun_path` limit, failing with `EINVAL`.

The vitest run now also covers `src/shared` (assembleCmd / agent config).

## How it works

`src/server/index.ts` runs one `node:http` server on `PORT` (plus a second listener on `PORT+1` that serves only the dev-server proxy, so proxied pages get their own origin and cannot read webterm's token): in dev it mounts Vite in middleware mode (HMR on that same port), and in production it serves the built `dist/`. A `ws` WebSocketServer on `/ws` multiplexes every terminal over one shared socket, keyed by a stable client-generated id. The server keeps each PTY alive across socket close (detach) and replays a 256 KB scrollback ring buffer on re-attach; a PTY dies only on explicit close or when the shell exits. PTYs are Bun-native (`Bun.spawn` with its inline `terminal` option), with no node-pty dependency.

Workspaces + layout are persisted in `bun:sqlite` (`src/server/db.ts`) as the source of truth, served over a small REST API under `/api` (`src/server/api.ts`); a node may be a terminal or an agent — an agent node spawns a CLI command via the login shell (`cmd` on the open message) instead of an interactive shell. When `tmux` is installed, each node's session lives on a webterm-owned tmux server (`-L webterm`) and is re-attached after a server restart; without it a restart reloads workspace + node definitions from the DB and respawns fresh PTYs.

Live agent status comes from Claude hooks, delivered as a settings file (`claude --settings <path>`) rather than an inline blob, that POST each lifecycle event to `/api/agent-status`; the server maps those events to working/waiting/blocked/done and broadcasts them over the WebSocket as a `StatusMsg`. A pre-set session UUID (`--session-id`) lets a finished Claude session be continued with `--resume`. The Board is a read-only client overlay over the same node data, and the folder picker is served by `GET /api/fs`.

Screens are URL-addressable (React Router, `src/client/appRoute.ts`): the open board is `/w/<workspace id>`, and Settings, the Central tab and the bottom-panel tab are search params (`?settings=agent`, `?ctab=memory`, `?panel=problems`). A reload or a pasted link lands on the same screen, and Back/Forward close and reopen them. Unknown values are dropped; in production every such path serves `index.html`.

The ledger is always on, so the server also exposes read-only inbox, memory, and orchestrator projections, plus a human approval surface under `/api/approvals/*`. That surface is not capability-authorized. It accepts only the webterm page in a browser and refuses agent credentials, so an agent cannot approve its own action. The P3-P5 work behind these routes is still partial. Central proposal MVP, Telegram bridge logic, and memory retrieval have additional limits documented in `RND/14-CENTRAL-AGENT-S0.md`.

Project health: Central scans each project (daily, or Scan now in Central panel › Health) with deterministic checks for oversized files, unreferenced modules, TODOs without context and empty `catch` blocks, and checks a task's changed files when it reaches review. Every finding cites its file, line, evidence and source rule; you dismiss it with a reason (remembered in memory) or reopen it, and Central only advises, never fixes on its own. Deep analysis is an optional read-only Claude run (about $0.50 at most, once per hour per project) whose claims are kept only when the server finds the quoted code. Design and limits: `docs/decisions/central-health.md`.

Agent nodes can be linked with context-link edges (persisted as workspace bridges); a linked node reads a bridged peer read-only over `GET /api/context-link` (verbs `list` / `summary` / `transcript` / `terminal`), fed by a POSIX-sh shim the server installs under the data dir. The sparkle button calls `GET /api/generate-name`, which spawns the `claude` CLI in print mode on a node's terminal buffer and returns a short Title-Case title. Live-view broadcast is intentionally absent — webterm's single-user loopback has no viewer or relay, mirroring nodeterm's Server Edition.
