# Changelog

## [0.4.0] - 2026-10-27
### Added
- Dock: a floating toolbar at the bottom of the canvas to add a node (Terminal, Agent, or Workspace), undo/redo layout changes, step viewport navigation back/forward, fit the view, toggle the Board, and zoom out/in.
- Resizable nodes: select a node and drag its edges to resize it; the size is saved with the workspace and restored on reload.
- Minimap: a bottom-right overview whose dots are colored by agent status (working, waiting, blocked, done) or blue for terminals, over a dot-grid canvas background.
### Changed
- The top-left panel is now a slim workspace switcher; adding terminals, agents, and workspaces moved into the dock.
- Terminal and agent nodes, plus the Welcome, Board, and folder-picker screens, were restyled to a consistent nodeterm palette.

## [0.3.0] - 2026-10-27
### Added
- Live agent status: each agent node shows a colored dot — working, waiting, blocked (needs permission), or done. Claude uses session hooks; other agents show liveness (working until exit).
- Board: a read-only Kanban overlay that groups agent nodes by status into Working / Waiting / Blocked / Done columns; click a card to center the canvas on that node.
- Folder picker: a Browse button beside the workspace and agent working-directory fields opens a server-side folder navigator instead of pasting a path.
- Resume: a finished Claude session can be resumed to continue its prior conversation; Restart still begins a fresh session.

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
