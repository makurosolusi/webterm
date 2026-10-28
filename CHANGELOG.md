# Changelog

## [0.5.0] - 2026-10-28
### Added
- Settings panel: a sectioned settings page (Terminal, Interaction, Shell & buffer, Agent, Canvas, Preview) stored in SQLite next to your workspaces, so it follows you across browsers. Terminal changes apply to already-open terminals live, with no restart.
- Terminal appearance is now configurable: eleven color schemes (webterm dark/light, Dracula, Tokyo Night, Catppuccin Mocha/Latte, Gruvbox Dark, Nord, One Dark, Solarized dark/light), font size/family/weight, line height, letter spacing, cursor shape and blink, minimum contrast, and GPU rendering.
- Terminal keyboard and mouse options: copy/paste and font-zoom chords (⌘+ / ⌘− / ⌘0), copy-on-select, middle-click paste, a configurable word separator, and a shortcut-priority setting for whether a chord reaches the shell or the browser.
- Canvas control cluster with a command palette (⌘K / Ctrl K) that finds any node by name or kind, plus buttons to add a file browser, open settings, and open help.
- Zoom rail: zoom in/out, fit view, and a view lock that freezes pan and zoom while leaving nodes movable.
- Help overlay listing the keyboard shortcuts that are actually wired up; Escape closes it.
- Sessions panel: a sidebar listing every live node grouped by workspace and status, with click-to-focus.
- File browser nodes: walk a directory on the canvas with breadcrumb navigation and open a file from it.
- Editor nodes: open a file in Monaco (loaded on demand) and save with ⌘S, with markdown preview (⌘M), image preview (PNG, JPEG, GIF, WebP, BMP, ICO, SVG, AVIF), and PDF preview.
- Voice dictation on terminal and agent nodes: the mic button in the node chrome now transcribes speech into that node's shell. It previously did nothing.
- Per-agent launch command override, so a given agent can be pointed at your own wrapper, alias, or account-specific command.
- `WEBTERM_HOST` to choose the bind address, and `WEBTERM_TOKEN` to set the shared secret required when that address is reachable from other machines.

### Changed
- The server binds loopback (`127.0.0.1`) by default and refuses to start on an externally reachable host unless `WEBTERM_TOKEN` is set. `/api` requests and `/ws` upgrades are now checked for same origin, and for the token when one is configured. A browser does not apply the same-origin policy to WebSocket, so any page you happened to have open could previously dial the local webterm and get a shell.
- Restarting an agent no longer discards the conversation: Restart asks the CLI to quit and relaunches it with the prior session resumed, and starting over from scratch is a separate New session action.
- Terminal scrollback is its own setting now, measured in lines (default 10,000), separate from the server's replay buffer, which stays measured in bytes (default 256 KiB). One value served both before, which gave every node a buffer hundreds of thousands of lines deep.
- Node chrome, dock, and status chips follow nodeterm's wording; an idle node shows no chip at all instead of a DONE badge.
- The envman profile field is gone from the agent form. Per-account launches are configured through the per-agent launch command setting instead.

### Fixed
- Opening a file that could not be read (missing, no permission, or actually a directory) showed an empty editor instead of an error, and the next Save wrote that empty buffer over the real file on disk. A failed read is now reported as a failure, and an empty editor means a genuinely empty file.
- Agent nodes failed to start with `load envman: no such file or directory` on every machine without that binary, because each agent command was wrapped in `envman`. Agents now launch with a plain command.
- Nodes added to the canvas were never saved and could not be undone, so anything you created vanished on reload.
- Cursor and Copilot agents launched with no session flags at all, so their sessions could not be resumed.
- An agent that exited on its own left a usable status token behind; the token now expires with the node.

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
