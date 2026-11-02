# Changelog

## [Unreleased]
### Added
- VS Code-style UI chrome: `@vscode-elements/react-elements` 2.4.0 with a `--vscode` Dark Modern / Light Modern theme bridge across 38 components. New ActivityBar, StatusBar, MenuBar, EditorTabBar, Breadcrumbs, SplitView, Dialog, Popover, Tooltip, Menu, Notification, QuickPick, Switch, and Card primitives. The shell now has a 35px title/menu bar, 35px editor tabs, 48px activity bar, 22px status bar, a docked 300px Sessions sidebar, VS Code Settings, a QuickPick palette, Inbox/Chat as one bottom panel, and node/file/editor toolbar, tree, and breadcrumbs. Canvas, xterm, Monaco, and React Flow behavior are unchanged. Gates: TypeScript clean, Vitest 2113/2113 with `--maxWorkers=4 --testTimeout=20000`, production build passing; visual checks via ego-browser.
- Tailwind v4 utilities-only and shadcn/ui foundation, with interactive chrome and controls migrated across the shell, dock, canvas, nodes, terminal/editor/files, sessions, inbox/kanban, chat, settings, and overlays. Canvas, xterm, and Monaco internals remain custom; remaining CSS is limited to layout, tokens, and engine internals after the cleanup.
- Default component migration for Cards, Tabs, Dialog, AlertDialog, and Command across the verified Sessions, Inbox, Chat, Settings, approval, dock, and command-palette surfaces, with roughly 420 lines of redundant CSS removed. Sessions, Inbox, and Chat are Card + Tabs surfaces with clickable close buttons; Settings is a full-screen Dialog with a translate reset; Add, Zoom, and Workspace creation are controlled Dialogs with verified Escape; and only the workspace topbar tabs, 38px dock rail, and node/xterm/Monaco/React Flow geometry remain custom. The dead `st-toggle-knob`, dock active, and backdrop rules are gone. Gates: 2025/2025 Vitest with `TMPDIR=/tmp`, TypeScript clean, production build passing.
- OpenCode 2.0.26 as the primary central runtime adapter, with JSON event parsing, env scrubbing, default-deny permissions, cancel, and session resume support.
- A typed proposal MVP for `goal.propose`, `plan.propose`, `task.assign`, and `approval.request`, including policy validation and `central.proposal` audit records.
- Central Telegram private-chat dispatch and bounded, read-only project memory retrieval behind their respective flags.
- Human approval surface under `/api/approvals/*`, separate from the capability-gated control plane. It can read a challenge, request, decide, and consume an approval, and a successful task review now moves the task to verified or failed instead of leaving it in `claimed_done`.
- Inbox panel with Needs you / Review / Broken filters, a consent dialog that requires the checkbox and the literal `APPROVE`, and an unread count on the dock. Task rows carry their fence so a review decision can target the right task version.
- Read-only ledger projections for the UI: `GET /api/inbox`, `GET /api/memory`, `GET /api/memory/search`, and `/api/orchestrator/*`.
- `WEBTERM_LEDGER` modes `off`, `shadow`, and `on`, plus the P3/P4/P5 foundations behind them: orchestrator roles, caps, plan store, worktree service, memory claim/promote with FTS5, and Telegram webhook verification, identity, and outbox.
- `WEBTERM_ALLOW_LOOPBACK_APPROVAL`, default `0`, as the explicit opt-in for token-free local approval demos.
- `WEBTERM_TELEGRAM`, `WEBTERM_TELEGRAM_WEBHOOK_SECRET`, and `WEBTERM_TELEGRAM_BOT_TOKEN` for the Telegram ingress. The legacy `TELEGRAM_BOT_TOKEN` name is still accepted.
- `.env.example` now documents the approval, ledger, Telegram, orchestrator, memory-file, and central flags, plus the fact that Bun auto-loads `.env`.
- A root-only orchestrator control plane: `POST /api/orchestrator/bootstrap` creates the project, orchestrator agent, worker agent, and plan in one transaction, and `POST /api/orchestrator/assign` creates the ledger task and locks the plan item to it. Every plan item needs an explicit, non-empty scope, and bootstrap refuses a path that is not an absolute, existing git root. `/api/orchestrator/run` needs an assigned item, and until now only a throwaway script could produce one.
- A production worker run behind `WEBTERM_ORCHESTRATOR_RUN=on`: it allocates a worktree, opens a real agent PTY, sends the task prompt, waits for the turn with a timeout, records the result, and closes the PTY and releases the worktree. A configured agent CLI is still required for the run to do work.
- Memory files behind `WEBTERM_MEMORY_FILES=on` and `WEBTERM_MEMORY_DIR`: `POST /api/memory/export` writes one fact to one Markdown file with JSON frontmatter and commits it, and `POST /api/memory/rebuild` treats the files as truth and reconstructs the SQLite index. Each `(project, scope, key)` gets its own path, the root is created `0700` and `git init`-ed on first use, files are `0600`, and the commit identity belongs to the server rather than to your host git config.
- Telegram egress and bindings: the bot sender drains the outbox with retry and backoff, sends only when a bot token is configured, and scrubs the token from every error. `GET`, `POST`, and `DELETE /api/channels/telegram/bindings` are root-only, and a group chat is refused the `approver` and `owner` roles.
- A central thin layer behind `WEBTERM_CENTRAL=on`: `GET /api/central/portfolio`, a per-project projection with plan, task, approval, and budget usage, plus pause, resume, and priority actions written to the audit log. It is a projection and control surface, not an autonomous agent.

### Changed
- Central chat can use `WEBTERM_CENTRAL_RUNTIME=opencode`; real free-model E2E now covers all four proposal tools, including pending approval creation without decision/run. B3 remains partial only for `task.run`/`approval.decide` and sustained credentialed-model/soak evidence. Proposal blocks render as compact cards without claiming applied or approved status. Real Telegram delivery and production memory E2E remain unverified.
- Approval dispatch reuses one deps object per ledger port, so the documented ten-minute `requestId` replay window works in production instead of allocating a fresh ack store per request.
- `.env` no longer carries `WEBTERM_TOKEN` and is kept at mode `600`. A root token must be exported explicitly, so it is not inherited by every process that reads the auto-loaded file.

### Fixed
- A task whose approval was approved but never consumed could not be finished from the inbox: the approval disappeared from every list, so a lost response left the task stuck. The inbox now shows "Finish approval" on that row, which opens the existing consent at the Consume step instead of minting a second approval, and the approved list now carries the task id, fence, and request so the row can be matched.
- Retrying an approval request with the same request id after the server restarted used to mint a second approval, because the reply cache lived only in memory. Approval replies are now written to the ledger, so the retry returns the original consent instead of asking for a second.
- Task review approvals no longer consume without effect: reject fails or reopens the task, and consume verifies it with the human reviewer and approval id recorded.
- The canvas minimap follows the dark canvas background instead of rendering as a white block.
- Ledger upgrade backups and the ledger database files created on first run are now readable only by their owner (mode `0600`), so other local users on a shared machine cannot read the audit trail or the backups taken before a schema upgrade.
- Memory file exports that differed only by scope shared one file: `project:deploy` and `scratch:deploy` both wrote `p1/deploy.md`, so the second overwrote the first and a rebuild could restore only one of them. A fact's path now includes its scope, `p1/<scope>/deploy.md`.
- A rebuild could silently revert a newer fact: the stale file left from before a supersede matched on project, scope, and key, and its old body overwrote the live row. Rebuild now skips a record older than the row it matched, and the newer body survives.
- The advertised 16 KiB cap on the new write routes was checked only after the whole request body had been buffered, so a large upload held all of it in memory before the `413`. The cap is enforced from `content-length` and by a streaming reader now, so an oversized body is refused before it is buffered.
- The control plane and the agent-status hook endpoint also checked their body size only after reading the whole request, so a chunked upload without a `content-length` could be buffered in full before the `413`. Both now read through a streaming cap, 64 KiB for control and 256 KiB for agent status, and refuse an oversized body as soon as it crosses the limit.
- Replay and consent regressions now have tests: the acknowledgement key is per node, merged control dependencies stay stable across requests, consuming an approval with the wrong digest is refused without spending it, a control approval request replays across a server restart, and the human approval in-memory fallback replays the original response instead of asking again.
- A worker run that threw after its PTY had opened, for example from a status or read error, left the PTY alive and the worktree held until the reaper. The rest of the run now runs inside the cleanup path: the PTY is closed and the worktree released before the failure is recorded.
- The first orchestrator run on a fresh install failed with `worktree_failed`, because `<data>/worktrees` was handed to git before anything had created it. The directory is created owner-only (`0700`) first, and a creation failure is reported as `worktree_root_failed` instead of a generic git error.
- A worker agent could receive only the first line of its task, because the prompt was multi-line and an agent that reads one line at a time saw a fragment. The prompt is collapsed to a single line before it is sent.
- The root-only route families added in this wave are now pinned in the node-token and capability negative tests, so adding one of them to the node allowlist fails the suite instead of passing it.

### Security
- Human approvals refuse token-free loopback by default. An agent shell on the same machine could otherwise request, read the nonce, approve, and consume its own action. A configured root token, or `WEBTERM_ALLOW_LOOPBACK_APPROVAL=1` for a disposable demo, is required.
- Node tokens and capabilities do not open the human approval route, so an agent cannot approve its own irreversible action.

## [0.7.0] - 2026-10-29
### Added
- A single-file standalone binary. `bun run build:binary` builds the web assets, embeds every one of them into the server, and compiles the whole thing to one executable `webterm`. It runs as `./webterm` from any directory with no `dist/` beside it — the assets travel inside the binary, not on disk.
- `HOST` as the name for the bind address, to sit beside the `PORT` it pairs with. `WEBTERM_HOST` still works as a fallback so existing setups are untouched, and a non-loopback `HOST` still refuses to start without `WEBTERM_TOKEN` rather than expose an unauthenticated shell.
- `.env.example` showing the `HOST` / `PORT` keys. Both the binary and the dev server read a `.env` from the working directory, so these no longer have to be exported by hand.

## [0.6.0] - 2026-10-29
### Added
- Split panes: a terminal node can be split into nested panes, the way Ghostty, iTerm and tmux do it inside one window. Each pane is its own shell, a split can itself be split (so a 2x2 is reachable), dividers drag to re-balance, and the layout is saved with the workspace. An unsplit node is unchanged, so existing boards keep working untouched.
- Clean view: hides every piece of chrome — tab bar, dock, sessions panel, minimap — and leaves only the nodes. A dock button enters it and the ⌘. / Ctrl+. chord leaves it; that chord now reaches the app even while keyboard focus is inside a terminal, which it has to, because the dock button is one of the things clean view hides. Not persisted, so a reload always comes back with the chrome.
- Right-click menu on the canvas: spawn a terminal, a file manager, or any enabled agent at the point you clicked, plus Select all and Fit view. Until now every new node landed in the middle of the view and had to be dragged where you wanted it.
- Workspace tab bar replaces the floating switcher: one tab per workspace with a live status dot on the open one, and a + at the end that can never be pushed off-screen. The strip fades whichever side is actually hiding tabs, reveals the active tab when you switch to it, and scrolls on a plain vertical mouse wheel.
- Workspace kebab menu with Rename and Delete. A workspace created by mistake could not be removed from the UI at all before this; deleting one also closes the shells of the nodes it orphans.
- Nodes tab in the Sessions panel: lists every node on the open board grouped by kind, click to center the canvas on it. File manager and editor nodes were listed nowhere before, because neither is a shell, which left them with no way to be reached.
- Unread group in the Sessions panel: a session that finished while you were looking elsewhere used to drop back to idle and read like every other idle row.
- Recently closed in the Sessions panel: a short history of closed sessions, newest first, that can be reopened where they were.
- Clicking the minimap moves the view to the clicked point, at the zoom you were already at. The minimap answered drag and scroll, but not the one gesture people reach for first.
- Opening a file from the file manager draws a cable to the editor node it spawns, and re-uses that editor instead of opening a second window for the same file.
- An agent now learns about its linked neighbours from webterm itself: the reply to a Claude hook event announces the live node roster into the agent's context instead of being discarded, so it no longer has to discover the context-link skill by itself.
- `POST /api/git/info` answers, for a batch of paths, whether each one is inside a git repo and if so its root, branch, head, dirty flag and ahead/behind against upstream. Read-only, and one git call per repo rather than per path. Nothing in the UI reads it yet — this is the data side only, so no branch is visible on the canvas.

### Changed
- Every canvas control is one dock column at the left edge now. The separate zoom rail is gone (zoom, fit and view lock moved into the dock), the Sessions panel's own floating launcher is gone (its toggle is an ordinary dock button), and opening the panel slides the panel out beside the dock instead of pushing the dock aside — the dock is where every button lives, so it is the surface that stays put.
- New terminals, agents and file managers appear in the middle of whatever you are looking at, offset slightly so two in a row do not stack exactly. They used to be born on a diagonal from the origin that ignored pan and zoom entirely, so on a board with a dozen nodes the next one landed off screen and had to be hunted for.
- The minimized Sessions sidebar takes a click to open; it no longer opens when the pointer merely crosses its icon. The left edge is also where the dock and the node toolbars are, so hover-peek swung the panel over the board during ordinary mouse travel toward something else. The Pin button goes with it: with no peek left it did exactly what the X beside it does.
- The Board overlay closes on Escape.
- Agents other than Claude read "No status" until they exit, instead of reading "Running" from the moment they spawn. Claude is the only agent webterm has a real status signal for, and a badge claiming work that has not started is worse than one that admits it does not know.
- `dompurify` is pinned to the patched version for Monaco's nested copy too, so `bun audit` reports no vulnerabilities. A cached `node_modules` keeps the old copy on disk and needs one `bun install --force`.

### Fixed
- Pressing Ctrl+C in `htop`, or in any other full-screen program, did nothing at all. The shell was spawned without a controlling terminal, so the tty had no foreground process group and the kernel had nobody to deliver SIGINT to. Terminals get a real controlling terminal now.
- Growing a terminal node left the new space blank, and full-screen programs kept whatever geometry they read at startup, because a resize changed the terminal size without ever telling the program about it.
- A node resized before a server restart came back with its shell at the size it was created at while the browser was already at the new one.
- Every control in the Settings panel was inert: font size, theme, cursor shape, copy-on-select and GPU rendering never reached a live terminal, which silently fell back to the defaults no matter what was set.
- Closing a node left its grandchildren running — burning CPU, and for an agent node burning tokens. Closing kills the whole descendant tree now, after a grace window so an agent can still flush its transcript and resume id; a process that had already detached itself from the node before the close stays out of reach.
- Selecting text in a terminal landed on the wrong cell as soon as the canvas was zoomed away from 100%: the selection drifted by the zoom factor, and drag auto-scroll started well above the bottom edge.
- Right-clicking a terminal node showed the browser's own "Copy Image" menu, because xterm draws into a canvas. It gets webterm's menu now, with Paste and Clear.
- Every row of every right-click menu did nothing when clicked: the menu opened, closed again on the click, and the action never happened. Split right, Split down, Paste, Clear and Close pane on a terminal node, New terminal, New agent and every submenu row on the canvas, Rename and Delete on a workspace tab, and Restart agent, Resume session and New session on an agent node were all inert — the same split a header button performed fine was dead from the menu. The menu dismissed itself on any pointerdown, including the one that landed inside its own panel, so the row was gone before the click could form on it.
- Collapsing a node destroyed its scrollback instead of merely hiding it, and the refresh button then looked broken because there was nothing left to redraw.
- Switching workspaces threw away that board's saved pan and zoom and made every node blink and resize, because the canvas rendered the new workspace before its nodes and viewport had arrived.
- A context-link cable drawn between two nodes vanished on reload, and closing a linked node left an orphan bridge behind in the database.
- With `WEBTERM_TOKEN` set, every Claude hook callback answered 403 — killing agent status badges, transcript registration, and with it the context links that read those transcripts. A token with surrounding whitespace broke the same path even where it otherwise worked; the enforced token has one canonical form now.
- Context links did nothing on a clean machine: webterm wrote the shim an agent calls but never installed a skill pointing at it, so no agent ever learned the shim existed. It installs its own skill at boot now, and the shim sends the auth token it was missing.
- Agent nodes exited with a 404 before the CLI ever ran when the launch command was wrapped by a third-party tool, because the hook settings were passed as an inline JSON blob that carried a callback URL onto the command line. They travel as a file path now.
- A newly added agent node read "Running" before the CLI had been given a single prompt.
- An agent waiting for permission looked exactly like one whose turn had merely ended — both showed a red pulsing NEEDS YOU. They are told apart by word, colour and motion now, and only a genuinely blocked node pulses.
- A node that had run and then stopped kept its Running badge forever once it had spawned a background subagent, whose hook events land after the parent's turn ends and raised it again with nothing after them to cancel it.
- A Running badge that goes silent for 20 minutes is withdrawn, so an exit that sends no closing event — Esc during a tool call, a killed CLI, a slept machine, a dropped connection — no longer leaves a node reading Running for the rest of the session.
- Restart and New session left a node reading Done with Resume and Restart still unlocked, although its shell had just been born and had said nothing yet.
- A status the server had withdrawn could still read as Running in the browser after a socket reconnect or a server restart, and a restarted server relaunched its agents bare instead of rejoining their conversation.
- A new agent node died in its first second with "No conversation found with session ID", because it launched with `--resume` against a conversation that had never existed.
- Reopening a session from Recently closed died instantly with "Session ID … is already in use".
- Resuming a Claude conversation whose transcript was no longer on disk — after the 30-day cleanup, an in-CLI `/clear`, or a close before the CLI wrote anything — killed the node at launch and dropped it to a bare shell. The `--resume` flag is dropped when the transcript can be seen to be gone, and kept when webterm cannot tell.
- Clicking New session on a live agent printed a `[process exited]` line belonging to the previous shell into the newly born terminal.
- Dragging a node re-rendered every other node on the canvas, and the status glows kept every status-bearing node permanently composited, which together are what made the board stutter and flicker during a drag.
- Clicking a session row that belongs to another board did nothing.
- Switching boards folded the previous board's group shut although nobody closed it, and the collapse state was lost on reload.
- Nothing in the Sessions panel said which board the canvas was actually showing.
- The mic button on a terminal node did nothing and left no trace when webterm was opened over a plain-http LAN address, where the Web Speech API does not exist at all; it hides itself there now. On agent nodes, dictation and AI-naming failures land in the node's activity thread instead of being swallowed.
- A malformed request body left the client hanging with no status and no body until it timed out, instead of being answered.
- `PUT /api/active` without a workspace id answered success while silently clearing the stored active board.

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
