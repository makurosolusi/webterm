# Canvas link capture: links opened from a terminal stay on the canvas

## Problem

`gh auth login`, `claude`, `vercel login`, `npm login` and friends open a sign-in page by calling `$BROWSER`, `xdg-open`
or `open`. A webterm terminal had none of those wired, so the machine's own Chrome opened outside the canvas. Rule of the
owner: anything started from the canvas (plain terminal, agent terminal, Agent Chat, Central, browser node) stays on the
canvas. Root cause: the session had no catcher for "open this URL"; only `<dataDir>/bin` (the `webterm` CLI) was on the
PATH of agent sessions, and plain terminals got no webterm env at all.

## Decision

1. Every terminal session (plain shell AND agent, any shell) gets `BROWSER=<dataDir>/bin/webterm-open`, `<dataDir>/bin`
   first on PATH and `WEBTERM_PORT` (`src/server/linkCapture/linkCapture.env.ts`, applied in `sessions.ts`).
2. `<dataDir>/bin` holds the catcher `webterm-open` and shims named `open`, `xdg-open`, `sensible-browser`,
   `x-www-browser`, `gnome-open` (`linkCapture.shims.ts`, written at boot, idempotent overwrite). A named shim takes over
   ONLY when every argument is a web URL (`http(s)://`, `ftp://`; the server refuses anything but http(s) with a visible
   reason, so an `ftp://` link never reaches the machine browser). `file:` URLs and web-like files (`.html`, `.htm`,
   `.xhtml`, `.svg`, any case) are REFUSED, not forwarded: they would open the machine browser. The shim prints
   `webterm: refused to open <arg>: ...` and exits 1; explicit app flags (`-a -b -R -e -t -f`) are the user's own choice of
   program and still pass (`open -a "Visual Studio Code" x.html`). `webterm-open` (a BROWSER handler, always a browser) has
   no such exception. Everything else (folders, other files, `open -a App <url>`, `mailto:`, `tel:`, a session without
   webterm credentials) goes to the real opener, found on PATH after the shim dir, with
   `WEBTERM_OPEN_BYPASS=1` set so nothing can loop back into a shim. `webterm-open` itself (the BROWSER handler) takes the
   first http(s) argument and ignores flags such as `--new-window`.
3. The catcher calls `POST /api/link-open {url}` (`linkCapture.route.ts`). The server (`browser/browser.linkOpen.ts`):
   validates the URL with the same navigation guard as the host (http/https only, no credentials in the URL, private
   addresses refused; `localhost` callbacks of OAuth flows are allowed on a loopback bind, the webterm port never);
   picks the browser node cabled to the origin node, or adds one next to it and cables it without asking; opens the
   link as a NEW TAB shown to the human (`activeTabId`, never the agent's `agentTabId`); at 8 tabs it reuses the last tab
   and says so; the live-browser gate (`maxLive`) is the existing one. The UI gets a short notice ("Link opened in canvas
   browser: host") and a polite reveal of the node (`t:'linkOpened'` + `t:'view'`).
4. Failure never falls back silently to the machine browser. The shim prints
   `webterm: could not open in canvas browser: <reason>; URL: <url>` to stderr and exits 1.
5. Settings > Browser card has the switch "Open links from terminals in the canvas browser" (default on,
   `WEBTERM_BROWSER_CAPTURE_LINKS`). Off = new sessions get none of the env, and a session started earlier is told
   `mode: machine` by the server and hands the link to the real opener. The switch applies to sessions started after the
   change; a running terminal keeps the env it started with (the server answer still honours the switch).
6. Agent briefing: capability `web.links` in `src/shared/agentCapabilities.data.ts` (chat and steward profiles); it is
   never listed under CANNOT for profiles without a terminal (`quietWhenDenied`).

Logging: only the hostname is logged and shown in the notice; the query of a sign-in URL can hold a token (Rule 12).

## Keeping the shim first on PATH

A login shell re-orders PATH after it starts (macOS `path_helper` in `/etc/zprofile` puts `/usr/bin` first), so an env
PATH alone loses to `/usr/bin/open`. Three layers (`linkCapture.shell.ts`), each proven with real zsh/bash in
`linkCapture.shell.test.ts`:

- `-l -c <cmd>` launches (agents, custom commands): the command is prefixed with `PATH=<bin>:"$PATH"; export PATH;`, which
  runs after the rc files.
- Interactive zsh: `ZDOTDIR` points at `<dataDir>/shell/zsh`, whose `.zshenv` restores the user's `ZDOTDIR`, sources the
  user's own `.zshenv` and registers a `precmd` hook that puts the bin dir first (kitty/iTerm style shell integration).
  All other user rc files are read from the user's own ZDOTDIR as usual.
- Interactive bash: an exported `PROMPT_COMMAND` does the same before each prompt (an existing one is kept after ours).

`BROWSER` survives all of this (only a rc file that unsets it can drop it).

## Threat model of the limited credential

A plain terminal has no node token on purpose. To let it say "open this URL in MY canvas" it gets a scope-limited
credential: `<mac>.<nodeId>` where `mac = HMAC-SHA256(per-install key, "link-open:" + nodeId)` (`linkCapture.identity.ts`;
key in `<dataDir>/link-capture.key`, 0600). It lives in a 0600 header file whose PATH is in `WEBTERM_LINK_HEADERS`; it is
never in env or argv (same rule as the node token).

- `auth.ts` accepts it on ONE path (`/api/link-open`); on every other path it proves nothing (tested). It is not a node
  token, so it opens none of the control, tools, status or context routes.
- The target is always the node the credential was issued to, and that node's own board; the body cannot name another node
  or workspace.
- Agent sessions use their node token instead (the claude sandbox only opens that node's own header file); the route accepts
  both.
- What a process that can read the file can do: ask the canvas of that one node to open an http(s) URL as a tab, through the
  navigation guard (the same thing the terminal's own user could do by pasting the URL). Nothing else.
- Revocation: closing the node deletes the header file; a node removed from the board fails the lookup; deleting
  `link-capture.key` and restarting invalidates every issued credential.

## What cannot be caught

- Programs that call `/usr/bin/open` (or `xdg-open`) by absolute path, or LaunchServices / `NSWorkspace` / `gio` / D-Bus
  directly (many Electron and native apps, some Go and Rust CLIs).
- `open -a <App> <url>`, `open -b`, and any call with a flag or a non-URL argument: deliberately the user's own call.
- `mailto:`, `tel:` and other non-web schemes: not web pages, they go to the real opener (the server also answers
  `unsupported_scheme` if one is posted). `file:` and web-like files are refused (see Decision 2). Whole-app picture:
  `canvas-containment.md`.
- Fish and other non-POSIX interactive shells keep `BROWSER` only (no PATH hook); a command launch under fish does get the
  PATH prefix. A user rc that overwrites `BROWSER`, `PROMPT_COMMAND` or `precmd_functions` drops that layer.
- Terminals started before the feature or while the switch was off (they keep their env until restarted).
- Browser feature off: sessions started then have no shims; older sessions get a visible 503, not the machine browser.
- Chromium missing or the live-browser limit reached: a visible refusal with the reason (close or hide another browser node).

## Turning it off

Settings > Browser on canvas > "Open links from terminals in the canvas browser". One link can still be sent to the
machine browser by calling the real opener by absolute path (`/usr/bin/open <url>`).

## Tests

`linkCapture.shims.test.ts` (real sh, fake server and fake opener: URL caught, non-URL passes through, no recursion,
failure prints reason and URL), `linkCapture.shell.test.ts` (real zsh/bash re-ordering rc), `linkCapture.identity.test.ts`
(scope: one route, one node), `linkCapture.route.test.ts`, `browser.linkOpen.test.ts` (node choice and cable, tab limit,
notices, log redaction), `sessions.linkCapture.test.ts` (env of plain terminal and agent, switch, browser off).
