# webterm

A node-based terminal manager: real shells run as draggable xterm terminals ("nodes") on a pan/zoom React Flow canvas. Terminals are persisted server-side and survive a browser refresh — reload the tab and each node re-attaches its PTY and replays its scrollback, so you never lose a running session by reloading.

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
- `NODE_ENV` — defaults to dev; set `production` to serve the built `dist/` statically.

Dev is not full browser HMR for every change: Vite HMR covers client edits live, but server edits need a restart.

## Build / production

```sh
vite build                                  # emits dist/
NODE_ENV=production bun src/server/index.ts  # serve dist/
```

## Tests

Split by runtime:

- `npm run test` — vitest (client store + ws reconnect).
- `tsc --noEmit` — typecheck gate.
- `bun test src/server/sessions.bun.test.ts` — Bun-only PTY round-trip / detach / scrollback-replay (needs `Bun.Terminal`, excluded from vitest).

## How it works

`src/server/index.ts` runs a single `node:http` server on one port: in dev it mounts Vite in middleware mode (HMR on that same port), and in production it serves the built `dist/`. A `ws` WebSocketServer on `/ws` multiplexes every terminal over one shared socket, keyed by a stable client-generated id. The server keeps each PTY alive across socket close (detach) and replays a 256 KB scrollback ring buffer on re-attach; a PTY dies only on explicit close or when the shell exits. PTYs are Bun-native (`Bun.Terminal` + `Bun.spawn`), with no node-pty dependency.
