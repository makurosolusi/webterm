# Changelog

## [0.2.0] - 2026-10-27
### Added
- Workspaces: create, name, and switch between saved boards; each workspace has an optional working directory and its own layout, persisted to a local SQLite database.
- Agent nodes: launch a CLI agent (e.g. Claude/Codex/Gemini) as a node that runs a command in its PTY, with a colored agent badge and a Restart button — alongside plain terminal nodes.
- Layout, node definitions, and the active workspace now persist across a full server restart (previously only across a browser refresh).
- `WEBTERM_DATA_DIR` environment variable to choose where the SQLite store (`webterm.db`) lives (default `~/.webterm`).
### Changed
- Canvas layout is now stored server-side in SQLite instead of browser localStorage, so it follows you across browsers and devices.

## [0.1.0] - 2026-10-27
### Added
- Node-based terminal canvas: open real shells as draggable terminals on a pan/zoom board.
- Terminals persist across browser refresh — reopening the tab re-attaches each shell and replays its scrollback.
- Bun single-port server (HTTP + Vite HMR + WebSocket on one port) with a Bun-native PTY backend.
