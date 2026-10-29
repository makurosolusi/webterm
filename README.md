# webterm

A node-based terminal manager: real shells run as draggable xterm terminals ("nodes") on a pan/zoom React Flow canvas. Terminals are persisted server-side and survive a browser refresh — reload the tab and each node re-attaches its PTY and replays its scrollback, so you never lose a running session by reloading. Terminals and CLI agents live in workspaces (name + working directory + layout) that are persisted in a local SQLite database, so your boards survive a server restart, not just a browser reload. The canvas has a left-edge dock (add nodes, undo/redo, viewport navigation, fit view, zoom, view lock, sessions panel, clean view), a status-colored minimap, and resizable nodes whose size is saved with the workspace. Agent nodes (Claude/Codex/Gemini) can be wired together with context-link edges — a linked node reads a peer's transcript or terminal read-only — and each agent node has an AI "name with AI" button that titles the node from its terminal output.

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
- `WEBTERM_HOST` — bind address (default `127.0.0.1`).
- `WEBTERM_TOKEN` — shared secret required on `/api` and the `/ws` upgrade. Optional on a loopback bind; **mandatory** when `WEBTERM_HOST` is reachable from other machines — the server refuses to start without it rather than expose an unauthenticated shell.
- `NODE_ENV` — defaults to dev; set `production` to serve the built `dist/` statically.
- `WEBTERM_DATA_DIR` — data directory for the SQLite store (`webterm.db`), default `~/.webterm-server`.

Dev is not full browser HMR for every change: Vite HMR covers client edits live, but server edits need a restart.

## Build / production

```sh
vite build                                  # emits dist/
NODE_ENV=production bun src/server/index.ts  # serve dist/
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

Agent nodes can be linked with context-link edges (persisted as workspace bridges); a linked node reads a bridged peer read-only over `GET /api/context-link` (verbs `list` / `summary` / `transcript` / `terminal`), fed by a POSIX-sh shim the server installs under the data dir. The sparkle button calls `GET /api/generate-name`, which spawns the `claude` CLI in print mode on a node's terminal buffer and returns a short Title-Case title. Live-view broadcast is intentionally absent — webterm's single-user loopback has no viewer or relay, mirroring nodeterm's Server Edition.
