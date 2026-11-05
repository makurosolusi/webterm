# Changelog

## [Unreleased]

Operator notes:
- New dependency `@ghostery/adblocker` (MPL-2.0) for browser-node ad and tracker blocking. Its prebuilt filter lists are downloaded into `<data dir>/browser/adblock/` and refreshed weekly in the background; startup never waits for the download.
- New files in the data dir: `<data dir>/browser/adblock/` (filter cache), `shields-off.json` (sites where Shields is turned off) and `<data dir>/backgrounds/` (uploaded canvas background images).
- A stored `agentLaunchCommands.claude` is moved into a Claude launch profile named "Custom" on first load (see below); nothing to do by hand.

### Added
- "Clone Repository…" next to "Open Folder…" in the workspace "+" menu, the File menu, the Welcome screen and ⌘K. Paste an `https://`, `ssh://` or `git@host:path` URL, or `owner/repo` for GitHub. The clone shows its progress, can be cancelled, and opens as a new workspace. The parent folder defaults to `~/webterm/projects`, which is created the first time something is cloned or created there. The last parent you used is suggested next time, and if that folder is gone the default is used instead. If a private repository fails to authenticate, the error tells you to run `gh auth login` or set up an SSH key.
- "New Project…" in the same places: it creates an empty folder under the parent you choose and opens it as a workspace. "Initialize git repository" is on by default and runs `git init` with an empty initial commit on `main`. Untick it to get a plain folder. A folder that already exists and is not empty is refused.
- Settings > Shell & buffer > "Default projects folder" sets where clones and new projects go. Browse to pick a folder, or Reset to default to go back to `~/webterm/projects`. Relative paths, files and folders inside the webterm data folder are rejected. A folder that doesn't exist yet is fine.
- Both dialogs show the full path before you create anything. Afterwards you get "Reveal in Finder" (on Linux it opens the file manager) and "Copy path".
- If the folder name is already taken, the dialog says so and offers the next free name (`name-2`, `name-3`, ...) in one click.
- Before cloning, webterm checks whether the repository is already cloned: in an existing workspace, in the default projects folder, or in the parent you chose. https, ssh and `owner/repo` forms of the same URL count as one repository. If it finds a match you can open that folder, or choose "Clone again anyway". When the check takes too long it is skipped and the clone goes ahead.
- A warning appears when the target is inside another git repository or directly in your home folder, and "Create anyway" lets you continue. A target inside the webterm data folder is always refused.
- Every icon-only button now has a tooltip, VS Code style: it appears after a short hover delay (500 ms), then moves instantly to neighbouring buttons, and opens on long-press on touch. Tabbing or arrowing onto a button shows it too, but a dialog focusing its close button on open does not. The tooltip shows the button's keyboard shortcut when it has one, and why it is disabled when it is.
- Claude launch profiles (Settings > Agent > Claude launch profiles) control how webterm starts Claude. Add a profile with a launch command such as `envman -e claude:malik-opus -- claude`: a wrapper that ends with `--` is enough (claude is added for you), and flags after `claude`, like `--model …`, are kept. Common typos are detected with an "Apply fix" button, and the card shows the exact command that will run. Pick which profile new Claude agents use ("Default for new Claude agents") and which one the Central Agent uses (or "Same as default for new agents"). The built-in "Default" profile runs plain `claude`.
- "Test" on a profile checks it step by step (the wrapper is on `PATH`, `claude` runs, Claude is logged in) and names the step that failed. The Central Agent's readiness check runs through its profile too, so credentials injected by a wrapper count.
- Each new Claude agent node remembers the profile it was started with; later edits to that profile apply on its next launch. If the profile has been deleted, the node launches with the default and prints a note in the terminal saying so.
- Launch profiles are used everywhere webterm starts Claude: agent nodes, Central turns and its helpers (classifier, summaries, node names, AI commit messages), headless jobs (default profile, or one named in the request), the orchestrator, templates, resumed sessions and Doctor, which checks the wrapper binary. Existing Claude nodes with the stock command use the default profile; nodes with a customised command keep it.
- Editors opened from a Files node have a "Show in Files" button in the header. It selects the Files node that opened the file, pans to it if it is not fully on screen and focuses it. With several Files nodes, the most recently linked one wins. The button is hidden when no Files node leads to the editor.
- Browser Shields: browser nodes block ads and trackers using prebuilt ad and tracking filter lists, cached in the data folder and refreshed weekly. If a download fails the cached lists are used; with no cache yet, nothing is blocked until a download succeeds. A Shields chip in the browser toolbar shows how many requests were blocked and turns blocking off or on for the current site.
- Browser device mode emulates a phone, tablet or desktop like Chrome DevTools' device toolbar: 11 presets (three iPhones, three iPads, Pixel 8, Samsung Galaxy S23, Surface Pro, Desktop 1440 and Desktop 1920), Custom size, and rotate. A device sets the viewport, pixel ratio, mobile flag, touch and user agent, and the page reloads when that identity changes. The page is scaled to fit the node, under a header showing the device, size and pixel ratio. Responsive (the page follows the node size, as before) is the default. The choice is saved on the node.
- Browser console: a Console drawer on browser nodes (toolbar button or ⌥⌘J while the node is focused) lists console messages, uncaught exceptions with stacks, and browser log entries such as network, CSP and security errors. Filter by level or text, Clear, and turn on Preserve log to keep entries across navigation (otherwise they are cleared; up to 500 per node). An eval prompt runs JavaScript in the page and is blocked while an agent is driving the page, like other page input. The toolbar button shows the error count.
- Console capture starts for a node only the first time its console is used (drawer opened, eval run, or an agent reads it), because always-on capture is detectable by anti-bot scripts. Messages logged before that are missing; the drawer says capture just started and offers Reload. Network and CSP errors are counted for the badge from the start.
- Agents can read the same console with `webterm browser console [limit] [level]`.
- Canvas background (Settings > Canvas background): replace the plain black canvas with a preset or custom color, a two-color gradient, or an uploaded image (png, jpeg, webp or gif, up to 10 MB) with blur, dim, gradient overlay and fit. The background stays put while you pan and zoom, and the dot grid color follows its brightness. Bright images show a contrast warning with a one-click recommended dim. Reset goes back to the default, and a missing image falls back to it too.
- Each workspace can keep the global background or use its own: workspace menu > "Canvas Background…" opens the same editor for that workspace.
- Claude provider: a fourth mode, "Custom command" (Settings > Capabilities > Claude provider), next to Claude Code login, Anthropic API key and Custom endpoint. Pick or create a Claude launch profile that holds your own command, for example `envman -e claude:malik-opus -- claude`. In this mode webterm does not touch any credential: your command supplies it. The profile becomes the default for new Claude agent nodes, existing nodes that did not deliberately pick a profile, the Central Agent and its helpers; a profile chosen explicitly elsewhere still wins.
- "Test connection" in Custom command mode runs `--version`, then one short `-p "."` ping, and reports the result without showing Claude's output. The card detects wrappers on your `PATH` (envman, direnv, op, doppler) and offers an envman template. It warns when the command looks like it contains a secret, and a restart hint appears for sessions started before the change.
- New endpoint `GET /api/claude-provider/detect` lists the detected wrappers. `PUT /api/claude-provider` accepts `{ "mode": "command", "profileId": "..." }`, and `GET /api/claude-provider` adds `profile`, `profileMissing` and `commandWarning` for this mode.

### Changed
- Canvas cables are thicker and higher contrast, with a soft halo so they stay readable over custom backgrounds. Hovering a cable thickens it, and the clickable area around it is larger.
- Nodes are resized only through the Resize toggle in the node header, or ⌘⌥R ("Node: Resize Focused Node" in ⌘K). Clicking or selecting a node no longer shows the blue resize frame. Resize mode ends on Esc, a click outside, typing in the node, collapsing or removing it, or locking the view.
- Opening a file that is already open (for example from a second Files node) now selects only that editor, pans to it if it is not fully on screen and moves keyboard focus into it. Before, an off-screen editor was only marked selected and it looked like nothing happened. Newly opened editors get the same treatment.
- The floating toolbar in the bottom-left of the canvas is gone; it duplicated the command palette, Files, Settings and Keyboard shortcuts and covered the canvas. "New Files Node" is now in the File menu and the activity bar "+" list, and the pill in the middle of the title bar opens Go to Anything and shows its shortcut.
- Some button labels changed with the tooltips: "Explorer" is now "New Files node" and "Help" is now "Keyboard shortcuts".
- Popups in browser nodes never replace the page you are on. Popups matched by the filter lists are closed and counted by Shields; other popups open as a new browser node beside it, at most 3 every 10 seconds.
- The Central Agent "Turn on" offer no longer mentions OpenCode.
- If the profile chosen for Custom command mode is deleted, agents and Central launch with the Default profile and the card shows a notice, instead of failing.
- A Claude provider test that times out now stops the whole process tree it started, not only the wrapper, so no `claude` process is left behind.

### Fixed
- Opening Chat and Inbox (or Problems and Output) together no longer stacks panels on top of each other. They are now tabs of one bottom panel with a single header: opening a view selects its tab, the Chat input stays inside the panel, and "Jump to bottom" sits above the input instead of covering messages.
- A browser node whose page crashed or disappeared now reports "crashed" instead of "not found", and Reload reopens it at its last URL.
- Deleting a workspace now also removes its canvas background override and its uploaded image (an image still used elsewhere is kept). The workspace delete never fails because of this, and startup cleans up leftovers from workspaces that are already gone.

## [0.8.0] - 2026-11-05
The control-plane programme (phases F0 to F6).

Operator notes:
- Ledger migrations v14 to v22 run automatically on first start: inbox items (v14), routines (v15), task DAG (v16), cost tables (v17), memory columns (v18), tool and embedding caches (v19), bake-off (v20), eval cases (v21), event time indexes and a rebuilt `cost_run` table (v22). All are additive except v22, which rebuilds `cost_run` once in a transaction and keeps its rows.
- A second listener for the dev-server proxy now binds on the same host at `PORT+1` (override with `WEBTERM_PROXY_PORT`; if the port is busy the OS picks one). Open it in firewalls only if you need it remotely.
- Install `tmux` to keep terminal and agent sessions alive across a server restart. Without it, sessions end on restart as before, and Doctor warns.
- Possibly breaking: Claude agents now run in the Claude Code sandbox on macOS by default, so an agent command that reads outside its allowed paths can fail; set `WEBTERM_AGENT_SANDBOX=off` (or switch it in Settings > Control) to restore the old behaviour. UI labels are now English, so anything that matched Indonesian text breaks. No route moved: `/proxy/<port>` is new and was never served on the main port.
- On boot webterm writes the `webterm` CLI to `<data dir>/bin/webterm` (prepended to `PATH` in agent sessions) and a `webterm-cli` skill stub to `~/.claude/skills/webterm-cli/SKILL.md`.

### Added
#### Control plane & policy
- One capability registry with schemas, risk tiers, receipts and catalog overflow, served at `/api/tools`.
- Policy principals, persisted grants, cable grants and attenuation; every decision is recorded as an event.
- Settings > Control shows every setting's effective value, its source and the reason, and lets you edit it there. Doctor checks with one-click fixes (Claude, OpenCode, skills, Telegram, ripgrep, tmux, sandbox, data dir, ledger).
- Policy rules UI, an Activity status-bar item, and the Diff view in the Dock.
- An opt-in classifier for gated actions, with a hard never-auto list and a 7-day policy simulator.
- Secret broker: runs commands with secrets injected and redacted from output, also exposed as MCP tools.
- Undo and redo for settings changes.
- Workspaces can be created as git worktrees, with include files, setup scripts (given `WEBTERM_ROOT_PATH` and `WEBTERM_WORKTREE_PATH`) and safe removal.
- Source Control panel with hunk staging and commits; push is human-only and shows a pre-push report first.
- Templates: save a canvas (layout, cables, launch commands, notes, routines, plan skeletons) as a parameterised template and create new canvases from it. Secrets and session ids are not captured; imported templates are validated as untrusted. Three built-in templates ship.
- `WEBTERM_LEDGER` modes `off`, `shadow`, and `on`, plus the P3/P4/P5 foundations behind them: orchestrator roles, caps, plan store, worktree service, memory claim/promote with FTS5, and Telegram webhook verification, identity, and outbox.
- `.env.example` now documents the approval, ledger, Telegram, orchestrator, memory-file, and central flags, plus the fact that Bun auto-loads `.env`.
- A root-only orchestrator control plane: `POST /api/orchestrator/bootstrap` creates the project, orchestrator agent, worker agent, and plan in one transaction, and `POST /api/orchestrator/assign` creates the ledger task and locks the plan item to it. Every plan item needs an explicit, non-empty scope, and bootstrap refuses a path that is not an absolute, existing git root. `/api/orchestrator/run` needs an assigned item, and until now only a throwaway script could produce one.
- A non-loopback bind with no `WEBTERM_TOKEN` now generates one: 43 characters of base64url, stored at `<data dir>/secrets/WEBTERM_TOKEN` (mode `600`, directory `700`). On a TTY the server prints the file path and a `?token=` URL; with any other output it prints only the path and the length. An environment `WEBTERM_TOKEN` still wins.
- Opt-in token on loopback: `GET /api/settings/token` (state), `POST /api/settings/token/enable` (loopback peer only, the value is returned once) and `POST /api/settings/token/rotate`. There is no disable call; to go back to open loopback, stop the server, delete the secrets file and restart. Both are also in Settings > Capabilities > Access token (see below), and both calls are accepted only from the webterm page (see Security). Limits: a same-uid local process can still read the file, WebSockets already open survive enable and rotate, and node tokens are unaffected.
- `WEBTERM_ALLOWED_HOSTS` (CSV of `host` or `host:port`) and a Host allowlist against DNS-rebinding. It is checked only while no token is enforced; a request with another `Host` gets `403 host_not_allowed`. Loopback names and the bind address are always allowed.
- `POST /api/settings/env/import` reads the `.env` in the boot directory. It is a dry run by default; `{"apply":true}` writes the values to Settings. Bootstrap keys are skipped and dangerous keys need the root gate.
- Env entries in `/api/settings/env` carry `envShadowed`, true when a stored Settings value hides a different process-env value.
- Settings search matches words people type, not only card titles: for example "chrome", "cookie", "token", or "localhost".
- An "Access token" card in Settings > Capabilities. It shows whether the token is on, and has "Enable token" (enable, from a page opened directly on this machine) and "Rotate token". Each asks for confirmation, then shows the link with the token once, with a copy button; this tab reloads with the new token when you press "Done" or close Settings. A token set in the server's environment is shown as such and cannot be changed here. The card has no off switch: to turn the token off, stop the server and delete the secrets file.

#### Agents & Claude provider
- Claude provider card in Settings: use the Claude login, an Anthropic API key, or a custom compatible endpoint for agents, Central and helpers. The secret is stored in a `0600` file under `<data dir>/claude-provider`, not in the database. Includes a connection test and a Doctor entry.
- `webterm` CLI for agent sessions: `agent-context`, capability calls (`webterm <tool> --json '{...}'`), `skills get`, `whats-new`, `browser`, `context`, and `eval run`.
- A `webterm` stdio MCP server with policy-gated registry tools, configured automatically per agent CLI (Claude, Codex, OpenCode, Gemini) through webterm-owned files only, never your global CLI config.
- Central runs its Claude tools natively over MCP, with guard approvals.
- All four spawn paths go through one `agent.spawn` with depth limit, cap, lineage and events.
- Agent nodes get unique names, colour chips, titles derived from their task, and stop actions.
- Node identity cards and human-confirmed procedural memory are delivered to agents.
- Persistent, exactly-once agent outbox delivered when the agent is idle; link notes go through it.
- Agent session transcripts are indexed and can be resumed; recently closed nodes are kept and can be restored with their cables after a reload.
- Terminal and agent sessions survive a server restart through a webterm-owned tmux socket (`-L webterm`).
- Read-only explore subagent and a ranked repo-map tool.
- OpenCode 2.0.26 as the primary central runtime adapter, with JSON event parsing, env scrubbing, default-deny permissions, cancel, and session resume support.
- A typed proposal MVP for `goal.propose`, `plan.propose`, `task.assign`, and `approval.request`, including policy validation and `central.proposal` audit records.
- Central Telegram private-chat dispatch and bounded, read-only project memory retrieval behind their respective flags.
- A production worker run behind `WEBTERM_ORCHESTRATOR_RUN=on`: it allocates a worktree, opens a real agent PTY, sends the task prompt, waits for the turn with a timeout, records the result, and closes the PTY and releases the worktree. A configured agent CLI is still required for the run to do work.
- A central thin layer behind `WEBTERM_CENTRAL=on`: `GET /api/central/portfolio`, a per-project projection with plan, task, approval, and budget usage, plus pause, resume, and priority actions written to the audit log. It is a projection and control surface, not an autonomous agent.
- Central Agent v2, a set of opt-in capabilities that require the ledger (`WEBTERM_LEDGER` not `off`). Every new flag defaults to off, and with all of them off the server behaves as before. Flags are listed in `.env.example` and Settings.
- Control plane: a persisted level per scope (`off`, `observe`, `propose`, `act_gated`, `act_envelope`) that is capped by the `WEBTERM_CENTRAL_AGENTS` mode (`off`, `propose`, `auto`), and a guard that rates every tool R0 (read) to R3 (irreversible) and holds anything above the level for a human approval card. Daily budgets (`WEBTERM_CENTRAL_DAILY_TOKENS`, `WEBTERM_CENTRAL_DAILY_SPAWNS`, `WEBTERM_CENTRAL_DAILY_COST_MICROS`), per-turn limits, and a persistent circuit breaker stop runaway work. `POST /api/central/halt` is a root-only kill switch that sets the level to `off` and closes central's agents; `GET`/`PUT /api/central/control` read and set levels.
- One typed tool registry for central, with a `toolsHash` over the registered set. Read tools (`project.read`, `node.list`, `task.status`, `run.result`, and others) behind `WEBTERM_CENTRAL_READ_TOOLS`; agent tools (`agent.spawn`, `agent.list`, `agent.read`, `agent.status`, `agent.prompt`, `agent.close`) and `task.run` behind `WEBTERM_CENTRAL_AGENTS=propose|auto`; `agent.relay` behind `WEBTERM_AGENT_MAIL`.
- Turn reliability: sessions resume across turns, orphaned turns are reconciled after a restart, and a turn is bounded by `WEBTERM_CENTRAL_MAX_STEPS`, `WEBTERM_CENTRAL_TURN_STEPS`, `WEBTERM_CENTRAL_TURN_WALL_MS`, and `WEBTERM_CENTRAL_TURN_TOKENS`. With `WEBTERM_CENTRAL_RELIABILITY=on`, autonomy uses a non-blocking dispatcher (`WEBTERM_CENTRAL_MAX_INFLIGHT`), event-driven wake, and a breaker per item. Non-Claude workers that go idle with a non-empty diff become completion candidates after `WEBTERM_AGENT_IDLE_DONE_MS`.
- Context and caching: a context assembler with checkpoints and session rotation (`WEBTERM_CENTRAL_CHECKPOINT`, `WEBTERM_CENTRAL_CONTEXT_WINDOW`) and a choice of tool bridge (`WEBTERM_CENTRAL_TOOL_BRIDGE=text|opencode`).
- Skill store: skills under `<data dir>/central/skills` with lint, a proposed-to-active lifecycle that needs human approval, and rollback (`WEBTERM_CENTRAL_SKILLS`, `WEBTERM_CENTRAL_SKILL_PROPOSE`; tools `skill.list`, `skill.load`, `skill.propose`).
- Knowledge base: a per-project index in `<data dir>/knowledge.db` with a Lite Map, a deterministic project brief, and tools `kb.search`, `kb.map`, `project.discover`, and `project.brief` (`WEBTERM_KNOWLEDGE`, optionally `WEBTERM_KNOWLEDGE_GRAPHIFY`).
- Central control panel: level and budget, a halt button, an agent list, approval cards for shared mutations, skill review, and a memory view, served by `GET /api/central/status|agents|approvals|skills|memory` and `POST /api/central/agents/:id/relay|close` and `/api/central/skills/:id/approve|rollback`. The panel is built only with `VITE_WEBTERM_CENTRAL_CHAT=on`.
- Not yet verified end to end: a real OpenCode run with native tools, real Telegram delivery (nothing yet sends the approval card to Telegram, so the buttons have no card to press), sustained load, and the control panel in a browser.
- Central Agent shows whether its engine is ready (Claude Code or OpenCode installed and logged in), with a "Check again" button that re-checks right away instead of using a cached result. The engine and the Chrome location can be chosen inside the "Turn on" offer itself, so the Dock and canvas menu can finish setup without opening Settings.
- The Central button is always in the Dock, and "Open in canvas browser" is always in the link menu. When the capability is off, clicking them offers to turn it on.

#### Inbox/approvals
- One Inbox for notifications, questions, reviews and gates, with actions, an attention policy and Telegram cards.
- Claude `PermissionRequest` prompts can be answered from the Inbox; doom loops are blocked and a checkpoint is taken before the prompt.
- Task completion is accepted only from sealed system evidence (verifier); handoff context is filtered.
- Desktop notifications, sound and a tab badge when an agent needs attention.
- Human approval surface under `/api/approvals/*`, separate from the capability-gated control plane. It can read a challenge, request, decide, and consume an approval, and a successful task review now moves the task to verified or failed instead of leaving it in `claimed_done`.
- Inbox panel with Needs you / Review / Broken filters, a consent dialog that requires the checkbox and the literal `APPROVE`, and an unread count on the dock. Task rows carry their fence so a review decision can target the right task version.
- Read-only ledger projections for the UI: `GET /api/inbox`, `GET /api/memory`, `GET /api/memory/search`, and `/api/orchestrator/*`.

#### Memory & context
- Typed, bi-temporal memory with tombstones, suppression, freshness and PII masking.
- Per-node incognito: an incognito node receives and writes no memory.
- Idle consolidator that proposes memory claims from idle transcripts (human Confirm required, daily token cap; claims from untrusted sources cannot be confirmed).
- Shared blackboard: agents can write only in their own namespace and propose elsewhere.
- LLM checkpoint summaries, evidence-backed handoff cards, "continue from yesterday", and an optional brief narrative.
- Deterministic morning brief from events, Inbox and usage, with restored sessions.
- Stable prompt prefix, local embeddings for memory search, and a tool cache for `git.diff` and `repo.map` keyed on the git tree.
- Provenance panel and glob rules in agent awareness.
- Memory files behind `WEBTERM_MEMORY_FILES=on` and `WEBTERM_MEMORY_DIR`: `POST /api/memory/export` writes one fact to one Markdown file with JSON frontmatter and commits it, and `POST /api/memory/rebuild` treats the files as truth and reconstructs the SQLite index. Each `(project, scope, key)` gets its own path, the root is created `0700` and `git init`-ed on first use, files are `0600`, and the commit identity belongs to the server rather than to your host git config.
- Memory: scoped long-term memory with `memory.remember`, `memory.remember_user`, `memory.search`, and `memory.get`, plus hybrid recall behind `WEBTERM_CENTRAL_MEMORY`. User-scope memory lives outside git under `WEBTERM_MEMORY_DIR`. Embeddings are used only when `WEBTERM_EMBED_URL` and `WEBTERM_EMBED_MODEL` are set; without them recall is lexical.

#### Automation (routines, DAG, bake-off, PR review)
- Routines: scheduled, event and API triggers with a shell precheck, catch-up, budgets and history; started at boot.
- Task DAG with structured briefs, file leases, human gates, a breaker and a stale-base guard. Draft a DAG from the omnibox into an approvable Plan node.
- Bake-off: send one prompt to 2 to 4 headless Claude agents, each in its own worktree, and pick a winner from cards showing diff stats, verifier result, cost and duration. Merging is explicit; losing worktrees are removed only after you confirm.
- PR review: a read-only Claude (Read/Glob/Grep) reviews a GitHub PR head in a fresh worktree; the findings become an editable draft in the Inbox and are posted with `gh` only after "Post review". A routine action can poll open PRs.
- Checkpoints: workspaces are snapshotted under hidden git refs before Central actions and before permission prompts; files can be rewound from the timeline. Halt takes a panic snapshot.

#### Editor & browser
- Language servers for TypeScript and Python over a gated `/ws/lsp` bridge: diagnostics, signature help, outline, rename with preview (nothing is written until Apply) and cross-file go to definition.
- Diff node to review working changes, annotate lines for agents and undo hunks.
- Find in Files, Quick Open, an omnibox and customizable keybindings from one command registry.
- Sensors: ports opened by agents are detected, `tsc`/`eslint` problems are shown, and workspace tasks can be run.
- Dev-server proxy at `/proxy/<port>` on a separate origin (`PORT+1`), limited to loopback ports seen by the port sensor and never webterm itself, so a proxied page cannot read webterm's token.
- Browser Design Mode: pick page elements, add a comment and send them (selectors, trimmed HTML, key styles, boxes, source location when known, cropped screenshot) to the cabled agent. Page content is marked untrusted.
- Browser latency chip showing input-to-frame p50/p95 with a per-stage breakdown.
- MCP Apps: `ui://` views from MCP servers open as sandboxed App nodes; their tool calls go through webterm policy.
- Browser node on the canvas, off by default (`WEBTERM_BROWSER=on`). It streams a server-side Chromium into a node, with a toolbar, lease chip (human or agent), optional agent control (`WEBTERM_BROWSER_AGENT`), and an encrypted cookie vault filled from the node's "⋯" menu (Import Cookies > From File…). "New Browser" appears in the Dock and canvas menu only when the feature is on; with it off nothing changes. Private networks are blocked unless listed in `WEBTERM_BROWSER_ALLOW_HOSTS`; `localhost` is allowed when webterm binds to loopback.
- Open a Browser node from a link or a drop. Right-click an `http(s)` link in a terminal or agent node and choose "Open in canvas browser", or drag a URL onto empty canvas. The node opens beside its source (or at the drop point). Opening a URL a Browser node already shows takes you to that node instead of opening a second one, without navigating it. Cmd/Ctrl+click still opens a normal tab. Not yet available: agents opening Browser nodes on their own.
- File manager overhaul in files nodes. New file/folder and rename use an inline name field instead of a browser prompt, with keyboard navigation (F2, Delete, arrows, Home/End, Shift/Cmd selection) and multi-select. Hidden-file and sort (name, size, modified; natural order, folders first) toggles are remembered per node across restarts. The extra capabilities below are each behind a `WEBTERM_FILES_*` flag that defaults to off; see the README.
- Delete moves to a trash (kept 30 days) with an Undo toast, plus restore, rename, and duplicate (`WEBTERM_FILES_MUTATE`). Shift+Delete is permanent and asks first. A rename that only changes letter case is allowed; a name that collides case-insensitively is refused.
- Editor saves are version-checked and atomic. When the file changed on disk since you opened it, a conflict bar offers Reload or Overwrite and your buffer is kept. The editor follows renames, deletes, and outside writes to the open file (`WEBTERM_FILES_WATCH`).
- Images, audio, video, and PDF open in viewers through `GET /api/fs/raw` with range requests and ETag (`WEBTERM_FILES_VIEWERS`). Upload (streamed, one file per request, capped by `WEBTERM_FILES_UPLOAD_MAX_MB`, never overwrites) and download (`WEBTERM_FILES_UPLOAD`).
- Live listing updates when files change outside webterm (`WEBTERM_FILES_WATCH`), git status marks on the list (`WEBTERM_FILES_GIT_STATUS`), and Quick Open on Ctrl/Cmd+P while a files node has focus (`WEBTERM_FILES_QUICK_OPEN`).
- Drag a file row onto a terminal pane to paste its shell-quoted path. No newline is added, so nothing runs.
- `WEBTERM_FILES_LIST_MAX` (default 5000) caps entries per listing. The new `/api/fs/*` verbs and the integration flow are covered by `src/server/fileManager.integration.bun.test.ts`; design decisions are in `docs/decisions/files-manager.md`.
- Not yet verified in a real browser or host: Monaco editing, 100 MB uploads and XHR progress, native drag-and-drop, pasting into xterm, `fs.watch` on macOS under Node, and a real WebSocket reconnect.
- Chromium is now found in more places when `WEBTERM_BROWSER_BIN` is empty: Chrome, Chromium, Chrome Canary, Edge, and Brave in `/Applications` on macOS, the usual Linux paths, every `PATH` directory, and the Playwright cache (newest revision first). Settings > Capabilities > Advanced has a "Chromium location" field that shows the binary in use and whether it was chosen automatically or by you, lists every candidate found on this machine for one-click selection, and has "Detect again" and "Use automatic" (clear your path and use auto-detection).
- Choosing "Browser" from the Dock "+" menu while the browser capability is off now offers to turn it on, the same offer the canvas menu makes, and opens the node once it is on. Before, the item was hidden.
- The Cookies dialog of a Browser node has a guide for getting a cookie file from your own browser: a cookies.txt extension, or a copyable `yt-dlp --cookies-from-browser` command, with a warning that a cookie file is a login and a reminder that signing in once inside the node is safest, because its profile persists.
- Browser address bar works as an omnibox: type an address or a search. Text that is not an address is searched with the engine chosen in Settings > Canvas > "Browser search engine" (Google by default; DuckDuckGo, Bing, or Kagi).
- Files nodes show write actions (rename, delete, upload, and so on) even when file editing is off, as locked items. Clicking one offers to turn the capability on.
- A blocked private address in a Browser node shows an "Allow host:port" button. It adds that address to the allowed hosts and reloads the page, with no restart.
- While agents may not drive the browser, the Browser toolbar offers "Let agents drive this browser". It explains the risk, asks for confirmation, and takes effect without a restart. The same switch is a sub-option of the Browser card.

#### Mobile & remote
- Installable mobile PWA at `/m` with Web Push notifications. VAPID keys are generated on first use and stored in the data directory.
- Telegram: QR pairing, canvas counts, a ledger-backed channel store, and forwarding to Telegram only while you are away from the desktop app.
- `WEBTERM_TELEGRAM`, `WEBTERM_TELEGRAM_WEBHOOK_SECRET`, and `WEBTERM_TELEGRAM_BOT_TOKEN` for the Telegram ingress. The legacy `TELEGRAM_BOT_TOKEN` name is still accepted.
- Telegram egress and bindings: the bot sender drains the outbox with retry and backoff, sends only when a bot token is configured, and scrubs the token from every error. `GET`, `POST`, and `DELETE /api/channels/telegram/bindings` are root-only, and a group chat is refused the `approver` and `owner` roles.
- Channels: Telegram dispatch acknowledges first and replies later, `callback_query` presses on approval buttons map to the same decision as a typed reply (`WEBTERM_CHANNEL_APPROVAL_BUTTONS`), and managed bots give one bot with a topic per project and an editable status card (`WEBTERM_CENTRAL_BOTS`, tool `channel.bot.propose`).
- Telegram: link a chat to a project with a one-time `t.me` deep link (press Start in Telegram; single use, valid 10 minutes). The card shows the bot's name ("Connected as @bot") and has "Stop bot", "Start again" (restart with the saved token), and "Unlink" (unlink a chat).

#### Observability (events, replay, cost, eval)
- Tamper-evident, append-only event log with pub/sub and an SSE stream; hook, PTY, filesystem and edge events are emitted.
- Live activity timeline with grouping, filters, focus and a chain-integrity status.
- Session replay: a scrubbable timeline per workspace or agent node correlating transcript, tools, approvals, diffs and cost, with "Rewind to here". Opens from ⌘K.
- Cost capture per Claude session, run estimates, and caps with an ROI pause; routines, DAG tasks and bake-offs are gated on cost (a bake-off that would exceed the daily cap is refused with `429 cost_cap`). The Cost panel shows Central prefix reuse.
- Eval cases from rejections: rejected approvals, dismissed memory proposals and checkpoint rewinds become scrubbed eval cases, reviewable in Settings > Control (Promote to golden, Dismiss, Export JSON) and replayable with `webterm eval run [--model fake|real]`.
- System log and an Output panel. The server now records tagged, structured events (PTY and agent lifecycle, workspaces and nodes, filesystem, settings, hooks, approvals, Telegram and channels, ledger, HTTP and auth errors, WebSocket connections) and browser errors, with secrets and personal data redacted. Open the Output panel from the status bar, the View menu, the command palette, or `Shift+Cmd+U` / `Ctrl+Shift+U`; it has a channel dropdown, level selector, filter, clear, auto-scroll lock, copy, and save. See "Logs and the Output panel" in the README.
- `WEBTERM_LOG_LEVEL` (default `info`), `WEBTERM_LOG_BUFFER` (default `5000`), and `WEBTERM_LOG_FILE` (default `on`, daily files under `<data dir>/logs`, 5 MiB per file, 7 files kept), also listed in Settings.
- Log API under the root-token gate: `GET /api/logs`, `GET /api/logs/stream`, `PUT /api/logs/level`, `POST /api/logs/client`, and `DELETE /api/logs`.

#### UI shell
- VS Code-style UI chrome: `@vscode-elements/react-elements` 2.4.0 with a `--vscode` Dark Modern / Light Modern theme bridge across 38 components. New ActivityBar, StatusBar, MenuBar, EditorTabBar, Breadcrumbs, SplitView, Dialog, Popover, Tooltip, Menu, Notification, QuickPick, Switch, and Card primitives. The shell now has a 35px title/menu bar, 35px editor tabs, 48px activity bar, 22px status bar, a docked 300px Sessions sidebar, VS Code Settings, a QuickPick palette, Inbox/Chat as one bottom panel, and node/file/editor toolbar, tree, and breadcrumbs. Canvas, xterm, Monaco, and React Flow behavior are unchanged. Gates: TypeScript clean, Vitest 2113/2113 with `--maxWorkers=4 --testTimeout=20000`, production build passing; visual checks via ego-browser.
- Tailwind v4 utilities-only and shadcn/ui foundation, with interactive chrome and controls migrated across the shell, dock, canvas, nodes, terminal/editor/files, sessions, inbox/kanban, chat, settings, and overlays. Canvas, xterm, and Monaco internals remain custom; remaining CSS is limited to layout, tokens, and engine internals after the cleanup.
- Default component migration for Cards, Tabs, Dialog, AlertDialog, and Command across the verified Sessions, Inbox, Chat, Settings, approval, dock, and command-palette surfaces, with roughly 420 lines of redundant CSS removed. Sessions, Inbox, and Chat are Card + Tabs surfaces with clickable close buttons; Settings is a full-screen Dialog with a translate reset; Add, Zoom, and Workspace creation are controlled Dialogs with verified Escape; and only the workspace topbar tabs, 38px dock rail, and node/xterm/Monaco/React Flow geometry remain custom. The dead `st-toggle-knob`, dock active, and backdrop rules are gone. Gates: 2025/2025 Vitest with `TMPDIR=/tmp`, TypeScript clean, production build passing.

### Changed
- All product text is now English. Settings tabs and capability cards have English names (for example Capabilities, Central Agent, Browser on canvas, Edit and upload files, Access token).
- Claude agents run shell commands in the Claude Code sandbox on macOS by default (`WEBTERM_AGENT_SANDBOX`, default `on`, applies on next launch), so they cannot read webterm secrets or other nodes' tokens.
- Node tokens are no longer placed in agent environments; agents read a per-node header file whose path is in `WEBTERM_NODE_HEADERS`. Git env vars are filtered from agent sessions.
- Headless agents (DAG tasks, routines, planner) get the Claude provider settings and a restricted tool list (`--tools`).
- `npm run test:bun` now finds Bun tests in every `src/server` subfolder, runs them with `--no-env-file` (a developer `.env` cannot change results) and a temporary `HOME`, and runs real-browser tests separately.
- Settings now exposes seven capabilities with one on/off switch each (applied immediately, no restart) instead of environment keys; the Environment and Channels tabs are removed.
- The ledger is always on, settings changes without a token need a same-origin `Origin` header (scripts use the token), and Worker approval defaults to on. Telegram setup is "paste a bot token".
- Full ENVSIMPLE entry: [docs/changelog/envsimple.md](docs/changelog/envsimple.md).
- Central chat turns now resume the previous session, and orphaned turns are reconciled and turn limits enforced.
- The server now handles SIGINT and SIGTERM itself and exits with 130 and 143, so the stop is logged and the log file is flushed before exit.
- `Shift+Cmd+U` / `Ctrl+Shift+U` is a new app-level chord: it passes through the terminal to the Output toggle instead of reaching the shell (where Ctrl+U would delete the line).
- Console output from the git, memory, env, and Telegram channel code now goes through the logger, so lines carry a time, level, and channel prefix.
- Central chat can use `WEBTERM_CENTRAL_RUNTIME=opencode`; real free-model E2E now covers all four proposal tools, including pending approval creation without decision/run. B3 remains partial only for `task.run`/`approval.decide` and sustained credentialed-model/soak evidence. Proposal blocks render as compact cards without claiming applied or approved status. Real Telegram delivery and production memory E2E remain unverified.
- Approval dispatch reuses one deps object per ledger port, so the documented ten-minute `requestId` replay window works in production instead of allocating a fresh ack store per request.
- `.env` no longer carries `WEBTERM_TOKEN` and is kept at mode `600`. A root token must be exported explicitly, so it is not inherited by every process that reads the auto-loaded file.
- A newly created file now opens in the editor. Files that are not UTF-8 open read-only with a banner, and binary files show a placeholder instead of loading into the editor. Audio, video, and archives are no longer treated as text.
- Known limits: DNS-rebinding against `/api/fs/*` is not mitigated (the token is the only guard); Quick Open without `rg` or a git repo does not read `.gitignore`.
- Boolean env flags accept `on|1|true` and `off|0|false` everywhere. `WEBTERM_X=1` used to read as off for many keys and is now on, including `WEBTERM_TRUST_PROXY`. The two security keys (`WEBTERM_ALLOW_TOKEN_MINT`, `WEBTERM_STRICT_HOOK_AUTH`) still need exactly `1`.
- Values from a `.env` file and `TELEGRAM_BOT_TOKEN` are no longer inherited by spawned shells. The data directory is created `700` and the database `600`.
- An invalid `PORT` now stops startup with an error instead of falling back to 8700. Known bind errors (port in use, no permission, bad address) exit 1 with one message.
- `WEBTERM_FILES_VIEWERS`, `_WATCH`, `_GIT_STATUS` and `_QUICK_OPEN` now default to on; they are read-only. `WEBTERM_FILES_MUTATE` and `_UPLOAD` stay off.
- The central chat panel is gated by the server flag `WEBTERM_CENTRAL_CHAT`; the build-time `VITE_WEBTERM_CENTRAL_CHAT` is gone.
- The legacy `TELEGRAM_BOT_TOKEN` name is deprecated: it still works, warns once, and is removed in the release after 0.7.0. Use the Settings value `WEBTERM_TELEGRAM_BOT_TOKEN`.
- The compiled binary no longer autoloads `bunfig.toml`.
- `.env.example` now lists only the eight bootstrap keys; everything else is set in Settings > Control.
- On macOS a second Chrome icon appears in the Dock while Browser nodes run, because Chromium now runs as a real (minimized, unfocused) window instead of headless.
- A `WEBTERM_BROWSER_BIN` (or Settings "Chromium location") path that does not exist is reported as invalid in Settings and the browser does not start; webterm does not silently fall back to an auto-detected Chromium. Fix the path or choose "Use automatic".
- Importing cookies into a Browser node is on whenever the browser is on. Open the node's "⋯" menu, then Import Cookies > From File…; every import still shows a preview and asks for confirmation. Nothing needs to be set; `WEBTERM_BROWSER_COOKIE_IMPORT=off` turns it off.
- The Worker orchestrator and Central Agent autonomy cards now actually let Central Agent run workers. Turning on Worker lets Central propose and run workers with an approval card for each action; Central Agent autonomy allows runs without a card per action. A value you set yourself in `.env` or the shell still wins. With no level stored, Central works at "approval per action" at most; running without approval cards always needs a person to raise the level.
- Central Agent never falls back to a simulated engine. When neither Claude Code nor OpenCode is found, it says so instead of answering with canned text. The demo engine is used only when chosen explicitly.
- A dangerous sub-option (such as letting agents drive the browser) asks for confirmation before it turns on, the same as the Central Agent autonomy card.
- Browser node messages are all in one language and come with a button to fix the problem where possible ("Browser settings", "Allow host:port").
- The 403 message when a settings change is refused explains why (the page was not opened directly on the machine running webterm) and names the real address to open, with this page's port.
- Importing cookies from a file skips Google login cookies (the `google.com` family and Google's device-bound cookies such as `SIDCC` and `AEC`), following Orca's import policy (MIT). Google ties those sessions to the browser they came from, so they would not work anyway. The preview says how many were skipped and asks you to sign in to Google directly in the Browser node. YouTube cookies are still imported.
- Browser nodes respond faster. Mouse, keyboard, and scroll input is sent to Chrome without waiting for each event to finish, frames are sized to the node's viewport (capped at 2048 px a side) instead of the full window, the server acknowledges each frame to Chrome as soon as it arrives, only the newest frame is painted, and the stale-size frames sent while a node is resized are dropped (for at most 500 ms). Measured on a trackpad scroll burst: the tail went from about 950 ms to about 25 ms, and frames from about 86 KB to about 43 KB.
- Agents can drive the browser by default (`WEBTERM_BROWSER_AGENT` now defaults to on). Wire an agent terminal node to a Browser node with a cable (edge) and the agent can drive it right away; the cable is the permission and is checked on every call, so no restart is needed. With several browsers wired, the agent picks one with `--node <id>`; with none wired, it gets a clear message asking you to connect one. Turn it off with the agent checkbox in the Browser toolbar or the "Let agents drive the browser" sub-option of the Browser card. Central's `browser_act` follows the same default.

### Fixed
- Secrets are redacted from agent tool inputs and Central transcripts before they are persisted.
- Secret files are ignored by webterm, and workspace repos are guarded against committing them.
- On macOS, Bun no longer blocks in `waitpid` when a PTY leader exits.
- A new Browser node now always loads its starting URL; before, it could stay on `about:blank`. A page that has not loaded can no longer overwrite the node's saved URL with `about:blank`.
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
- New File no longer overwrites an existing file. Creation is exclusive and answers "already exists" instead.
- Saving (Cmd+S) no longer clobbers changes made elsewhere, and no longer silently recreates a file that was deleted. A stale save is refused with a conflict; a clean buffer does not write at all.
- Large or multi-byte saves no longer corrupt non-ASCII text, and request bodies are capped (413 instead of unbounded memory).
- Opening audio, video, or zip files no longer loads them as editable text, where a save would have destroyed them.
- Files watch resubscribes after a WebSocket reconnect, so listings keep updating.
- Central chat from Telegram, or from a project bound in the UI, no longer fails with `project_not_found` on the first message. Those chats carry a workspace id, and no ledger project existed for it; the first turn now creates the ledger project from the workspace (same id, its name and folder), once.
- Telegram chats waiting for a reply are no longer dropped when the Telegram channel is refreshed (for example after a settings change). The pending list still lives in memory and does not survive a server restart.
- The central tools `node.list`, `browser_status`, `browser_act`, and `project.discover` no longer answer `workspace_unavailable` or an empty list. They looked for workspaces in the ledger database, but workspaces are stored in `webterm.db`.
- The OpenCode central runtime works next to your own OpenCode. It runs `opencode run --standalone`, so it no longer collides with a running `opencode serve --service`. Its isolated home now gets the credentials of the configured model's provider, copied from your OpenCode login with `opencode auth export` and `auth import` through memory (never written to disk or logged), instead of failing every turn with `provider.no-route`. `GET /api/central/health` now checks OpenCode for real and reports `runtimeIssue` and `runtimeHint` when it is not ready, and a failed turn shows a one-line cause taken from OpenCode's stderr, with secrets redacted.
- Google and similar sites no longer flag Browser nodes as a bot. Chromium used to run with `--headless=new`, which exposes a `HeadlessChrome` user agent and `navigator.webdriver` set to true. It now runs headful in a background window per node, without focus (minimized on macOS, off-screen on Linux and Windows), following Orca's approach. `WEBTERM_BROWSER_HEADLESS=on` brings back headless as a fallback; Linux without a display uses headless automatically and logs a warning.
- "Turn on what’s needed" turns on the missing prerequisites of that card only. Before, it reset every capability.
- A capability that is waiting for a setup step can always be switched off. Before, its switch was disabled.
- "Check again" for an OpenCode engine now updates the status right away. The re-check used to bypass the shared cache without replacing it, so the next status poll could still show "not ready" for up to 30 seconds.
- Wiring or unwiring an agent and a Browser node takes effect immediately. Before, the change applied only after the agent session restarted.
- Telegram replies render Markdown. Agent text is converted to Telegram HTML, file names such as `note.md` no longer turn into links, and a message Telegram refuses to format is sent again as plain text.
- Long Central replies reach Telegram complete, as several messages in order (up to 32,000 characters in total). A send that fails partway resumes where it stopped, without repeating parts already delivered.
- Central sees every canvas workspace as a project. Before, it saw only the workspaces it had already chatted with. A new `project.list` tool lists them, and the portfolio panel shows all workspaces.

### Removed
- Central's text proposal parser; Central proposals are MCP tool calls now.
- The unused `NODETERM_PERM_WAIT_SECS` is no longer injected into agent sessions.
- Four dead keys from the env registry: `WEBTERM_CENTRAL_TOOL_BRIDGE`, `WEBTERM_KNOWLEDGE_GRAPHIFY`, `WEBTERM_EMBED_URL`, `WEBTERM_EMBED_MODEL`. The unused `WEBTERM_CHANNEL_HMAC_SECRET` entry in log redaction is gone too.
- `WEBTERM_ALLOW_LOOPBACK_APPROVAL`. Approvals from the webterm page need no configuration now (see Security).
- Codex as a Central Agent engine choice: it has no adapter, so it could only ever show as ready without working.

### Security
- Human approvals work from the webterm page with zero configuration, and agents cannot approve their own actions. `/api/approvals/*` and token enable/rotate accept a request only when it comes from the webterm page in a browser (`Sec-Fetch-Site: same-origin` and a same-origin `Origin`), and refuse any agent credential (node token or capability) with `403 agent_cannot_approve`. A root token, when enabled, is still checked first. Accepted limit: a local process running as the same user that deliberately forges these headers still passes; enable the root token to close that. Details: `docs/decisions/approval-ui-origin.md`.
- Node tokens and capabilities do not open the human approval route, so an agent cannot approve its own irreversible action.
- Without a root token, the terminal (`/ws`) and Browser node (`/ws/browser`) WebSockets accept only a connection that carries the webterm page's `Origin`, as a browser always sends. curl, agent shells, and other local processes without one are refused with `403 origin_required`, so they can no longer open a fresh shell or watch your browser. With a root token the token is checked as before. Accepted limit: a local process that forges `Origin` still passes; enable the root token to close that.
- An agent terminal can drive only the Browser nodes wired to it by a cable. Before, an agent with no cable could drive the only browser on the board.

## [0.7.0] - 2026-10-29

### Added
- A single-file standalone binary. `bun run build:binary` builds the web assets, embeds every one of them into the server, and compiles the whole thing to one executable `webterm`. It runs as `./webterm` from any directory with no `dist/` beside it — the assets travel inside the binary, not on disk.
- `HOST` as the name for the bind address, to sit beside the `PORT` it pairs with. `WEBTERM_HOST` still works as a fallback so existing setups are untouched, and a non-loopback `HOST` still refuses to start without `WEBTERM_TOKEN` rather than expose an unauthenticated shell.
- `.env.example` showing the `HOST` / `PORT` keys. Both the binary and the dev server read a `.env` from the working directory, so these no longer have to be exported by hand.

Rilis 0.6.0 dan sebelumnya: lihat [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md).
