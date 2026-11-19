# Browser profiles

Status: server side implemented (feature/browser-profiles-server); agent side (Central tools, CLI, capability registry) in feature/browser-profiles-agent; UI implemented (feature/browser-profiles-ui).

## Why a profile is its own entity

Before: one persistent Chromium profile per workspace, so every browser node of a board shared one login. Five accounts
with different roles meant logging out and in again. A **profile** is now a first-class thing: a persistent user-data dir
(`<dataDir>/browser/profiles/<id>`) plus an encrypted cookie vault (`<dataDir>/browser/vault/<id>.enc`), with a name and a
color (the workspace palette: 12 hues x 3 shades). Spawn five browser nodes on five profiles and all five stay signed in.

## One profile = one Chromium process

The process pool is keyed by profile id, not workspace id.

- Nodes on the **same** profile share one Chromium process and one session. That is what "same profile" means; there is no
  dialog and no blocking.
- Nodes on **different** profiles run in separate processes with separate cookies, storage and cache.
- A node without an explicit profile uses the **Default** profile of its workspace.
- The one rule that decides it is `resolveProfileId(workspaceId, node)` in `src/shared/browser.profile.ts`. Launch, wake of a
  discarded page, cookie injection, the version probe, the agent verb `open` and the idle classifier all go through it (the
  host takes it as `profileOf`; the live board is the source, plus the UI's latest switch until the board is saved).
- Switching a node to another profile moves the node: its page closes in the old process and reopens on the last URL in the
  new profile's process. The profile itself is never overwritten.

`MAX_LIVE` is unchanged: it still counts live **pages** (nodes) through the single `lifecycle.attach` gate, which is
stricter than counting processes (a page needs a process). Switching profile cannot get around it.

**The limit is a setting (range 1 to 12, default 3).** Settings > Browser > "Active browsers limit" writes
`WEBTERM_BROWSER_MAX_LIVE` through the same env PUT as other registry rows. The runtime reads it on every `attach` (a getter,
not a value captured at start), so a change applies without restart. Raising gives slots at once. Lowering below the active
count never kills a visible, loading or driven browser: `admit` evicts the oldest hidden ones until a slot is free, and idle
discard handles the rest. Limit toasts (profile spawn, tab open) carry "Raise limit to N+1" and "Settings"; Central cannot
change the limit (its `browser_limit` receipt tells it the owner can).

## Migration (no data moves)

Every workspace gets a Default profile row with `id = workspaceId`, named `Default (<workspace name>)` (made unique with a
numeric suffix). Because the id equals the old key, the existing profile dir and vault blob are the profile's own files: no
copy, no rename, existing logins survive. This runs at boot and whenever the list is read; it only inserts missing rows.
New profiles use a random `bp-<12 hex>` id and their vault blob is encrypted with AAD = that id (old blobs keep AAD =
workspace id and stay readable). The row table is `browser_profile` (`ensureBrowserProfileTable`, `IF NOT EXISTS`).

A browser node stores an optional `profileId`; nodes written before this change have none and mean "Default".

## Rules

- Names: trimmed, 1-40 chars, no control characters, unique ignoring case. New profiles get a random hue no other profile uses.
- A profile cannot be deleted while a node uses it (`profile_in_use`), nor can a workspace's Default while that workspace
  exists (`profile_default`). Deleting stops the profile's process and removes its dir and vault.
- Duplicate copies the dir (minus Chromium's per-process lock files) and re-encrypts the vault under the new id. It is
  refused while the source runs (`profile_live`): copying a live profile yields a torn database.
- Agent `open` takes `profile` (id or name, case-insensitive). A browser is reused only if it runs the SAME profile, so an
  agent is never handed the wrong account. Without `profile` the old behavior applies. A profile bound to another board is
  refused; an unknown name answers with the list of available names.
- The idle classifier takes an optional wanted profile; a node on another profile is `other_profile`, never idle.

## Security

- Cookie values are never logged (`cookieRedact`), never returned except by the explicit human export, and are encrypted at
  rest (AES-256-GCM). The vault key is untouched.
- Export (`GET /api/browser/profiles/:id/export`) and all management routes sit behind the `/api/*` UI gate; node tokens
  have no path to `/api/browser/*`, so agents cannot export or manage profiles over HTTP.
- Profile ids are validated as one path segment (no traversal) and cannot be `profiles` or `status`.
- The Google import policy is unchanged: source-bound Google sign-in cookies are skipped and reported as `skipped`
  (`reasons: ["google_source_bound"]`).
- SSRF proxy and navigation guard are untouched.
- A profile change made by an agent leaves a bounded ledger note (kind `browser.profile`); there is no permission card.

## Endpoints (all under `/api/browser`)

| Method and path | Purpose |
| --- | --- |
| `GET /profiles[?workspaceId=]` | list with `live`, `nodeCount`, `cookieDomains` |
| `POST /profiles` | create `{name, color?, shade?, workspaceId?}` (201) |
| `PUT /profiles/:id` | rename / recolor |
| `DELETE /profiles/:id` | delete (204; 409 `profile_in_use` / `profile_default`) |
| `GET /profiles/:id/cookies` | domains + TTL, no values |
| `DELETE /profiles/:id/cookies[?domain=]` | clear one domain or all |
| `POST /profiles/:id/cookies/preview` | parse a cookie file, summary only |
| `POST /profiles/:id/cookies/import` | `{format, content}` in one step, or `{previewId, domains}` |
| `POST /profiles/:id/duplicate` | `{name}` (409 `profile_live`) |
| `GET /profiles/:id/export` | storageState JSON download, re-importable |
| `POST /:nodeId/profile` | move a node to `{profileId}` |

The server broadcasts `{t: 'browserProfiles'}` on a list or live change; clients refetch the list.

## Not verified without a real Chromium

Process sharing/separation, session persistence across wake, and cookie injection into two live profiles are covered by
tests over a fake CDP server and fake launchers, not by a real browser.

## Agents and profiles

An agent must know it can use profiles (three earlier "agent forgot it has a browser" bugs). So the ability is declared ONCE in
the capability registry (`web.profiles`, `src/shared/agentCapabilities.data.ts`) and everything derives from it:

- Granted to `central.steward` and `chat.default`; **denied** to both skill-author profiles (they browse signed out, read-only).
- Central: `browser_open {profile}` (name or id, any case; none = the board's Default), `browser_status` (each browser's profile
  name+color, plus `profiles`: name, live, nodeCount), `browser_profile` `list` | `create {name, color?}` (tier R1, no card in
  default bypass; the color is random among unused hues). An unknown profile is a `denied` receipt whose `next` lists the names.
- Idle reuse: only a browser on the SAME profile (`classifyBrowserNode(..., wantedProfile)`); Central's idle ports provide
  `profileOf` from the stored board (`storedProfileOf`). Without `profile`, only the board's Default is reused.
- Terminal agents / Agent Chat: `webterm browser open [--profile <name>] [url]`, `navigate --profile`, `webterm browser profiles`
  (GET `/api/control/browser/profiles`, names/colors/live only). The skill `webterm-browser` documents it.
- Skill-author preset: the server lock refuses `profile` (`profile_not_allowed_for_preset`) and `profiles`; the chat tool lock
  regex never accepted flags. Tests pin both.
- Live names: Central's volatile Capabilities line ends with `Browser profiles: "work", "personal" +N more.` (at most 10, custom
  profiles first); a chat gets the same line after its briefing, and a changed list sends the existing
  `[webterm] Capabilities updated` note (the hash covers the names via `capabilityHash(profile, off, live)`).
- Every profile an agent creates leaves a bounded ledger note (kind `browser.profile`); no permission card.

**Why agents cannot import, export or delete cookies or profiles:** cookies are session credentials. Only a human, in the UI
behind the `/api/*` gate, may handle them. `browser_profile` therefore has no such action and the CLI has no such verb.

## UI

Modeled on Chrome profiles, Firefox containers and VS Code profiles: the profile is always visible where a browser shows,
and switching it is one click.

- **Node header chip** (`BrowserProfileChip`): color dot + name (tooltip: "Nodes on the same profile share cookies and
  logins", plus the node count when shared). The menu lists profiles (checkmark on the current, `live` and node count per
  row), then New profile… and Manage profiles… (opens Settings › Browser). Picking a profile calls `POST /:nodeId/profile`;
  only after the server answers is `profileId` stored on the node (so a refusal leaves node and board unchanged), and one
  notice reports "Moved to profile X; page reloaded". A failure shows an error notice with Retry. The board's own Default
  is stored as no `profileId`, so a copied board never points at another board's Default.
- **Spawn**: "Browser with profile…" (one click on a profile) and "Open a browser for each profile…" sit beside "Browser" in
  the canvas menu, the handle menu, the Dock add list and the command palette. Both open one dialog
  (`BrowserProfileSpawnDialog`, driven by `browserProfile.spawn.ts`, no prop plumbing). The "each" dialog starts with every
  profile ticked, has Select all and "Open N browsers"; nodes land in a grid (`browserProfile.layout.ts`, never overlapping
  each other or existing nodes) and the view fits them. The live limit is read from `/api/browser/status`: what fits
  opens, the rest is named in one warning notice.
- **Settings › Browser** (`BrowserProfilesSection`, searchable): per row dot, name, Default/live badges, "used by N nodes",
  "N cookie domains" and a menu: Rename (inline), Color (the workspace palette picker rows), Import cookies…, Duplicate
  (disabled with reason while live), Export cookies (download), Delete (confirmation; disabled with reason when used or
  Default). Server codes map to plain sentences and show inline. States: browser off, loading, failed + Retry, empty.
- **Cookies per profile** (`BrowserProfileCookieDialog`): preview (sites, counts, skipped Google sign-in cookies with
  the reason), choose sites, import, summary; stored sites with remove per site / all.
- **Live updates**: `BrowserProfilesMsg` is part of `ServerMsg`; `subscribeBrowserProfiles` feeds `useBrowserProfiles`.

Not verified without a real browser: how the dropdown, dialogs and the N-node grid look and feel, drag/keyboard focus
order in the menus, color contrast of the dots in both themes (tokens are reused from the workspace palette).

## A new node on a profile: the profile travels with the first attach

A node created in the UI with a profile (dialog "Browser with profile…", "Open a browser for each profile…") exists only on
the client until the board save fires (400 ms debounce), but its WS `attach` arrives at once. The server resolves the profile
from the SAVED board (`profileOf` -> `resolveProfileId`), found no node, and opened the workspace Default instead: the
picked profile was ignored and the launch used (and could fail on) the Default's process. Proven by
`browser.newNode.bun.test.ts` (acquired `["w1"]` instead of the picked profile id).

Fix: `attach` carries an optional `profileId`; the gateway calls `hintProfile`, which sets the node's profile override only
when the node is NOT on the saved board yet, the id is a known profile and it is global or this board's. The saved board
always wins afterwards, a switch still goes through `POST /:nodeId/profile`. Agent/Central opens add the node to the board
before starting it, so they read the profile from the board and need no hint (same test file, via `openFor`/`openProject`
paths in `browser.profiles.runtime.bun.test.ts`).

Log: `browser.launch_failed` carries `reason` (see `browser-tabs.md`, "A node that cannot operate").

## Who is signed in

A profile can show which Google and GitHub accounts are signed in (name and a masked email), checked inside the profile's own
Chromium and cached per profile; see `browser-profile-accounts.md`. The profile list gains optional `accounts`, and the chip,
its menu and Settings > Browser show them. A Settings switch turns the whole thing off.

## Cookie import UX

Symptom (owner report): the import looked unfinished. The ⋮ menu opened a wide submenu holding one item ("From File…") and a bold
Google sentence rendered as a menu row; the dialog showed native `<select>`, `<input type=file>` and `<details>`, a long red
paragraph for an ordinary security note, a claim of "only the sites you pick" with no way to pick, and no preview.

Design (reference: browser data import in Chrome/Edge/Firefox, password-manager import). One dialog, `browserCookies/CookieImportDialog`,
serves both entry points through a `CookieTarget` (workspace browser from the ⋮ menu, profile from Settings > Browser):

1. **Pick**: a drop zone plus a "Choose file…" button (the real input is `sr-only`, labelled, `accept=.json,.txt,.cookies`). Initial
   focus is the button. Oversize (> `COOKIE_BODY_MAX_BYTES`) and wrong-extension files are refused client-side with a specific message.
2. **Format** is detected by sniffing the first characters (`{`/`[` = JSON: Playwright storage state or a Cookie-Editor array;
   tab-separated rows = Netscape). The Format `Select` appears only when detection fails or the user asks to change it.
   The server parser stays the single source of truth for formats (`cookieImport.parse.ts`); the client never parses cookies.
   Only the `File` handle is kept between steps, so a format override re-reads the file instead of holding its text in state.
3. **Preview** (server `/preview`): sites with cookie counts, all ticked by default, Select all/none, a filter above 8 sites.
   Names and values never reach the UI. Google sites come back as `blocked: [{domain, count, reason}]` and are listed inline,
   disabled, with the reason; they no longer fail or hide anything. `googleSkipped` stays for the summary count.
4. **Import N cookies** (disabled with a reason line at 0), spinner on the button, inputs locked, Esc/outside click/close ignored
   while in flight. The commit sends `{previewId, domains}` of the ticked sites only (the contract already had the allowlist).
5. **Result**: imported count and sites, skipped count with the reason sentence, "Done" and "Import another file".
6. **Errors** are classified once (`classifyCookieError`: workspace `bad_request/not_found/disabled/payload_too_large` and profile
   `cookie_import_*` codes, HTTP 413, failed fetch) and each kind says what happened and what to do. `cookie_import_disabled`
   replaces the form by an explanation and an "Open Settings" action.
7. **Security note** is an `Alert` in the caution tone with a shield icon, a one-line risk statement and a folded "Learn more"
   (Collapsible). Red (`destructive`) is only used for real errors. "How to get a cookie file" is a Collapsible naming
   Cookie-Editor/EditThisCookie, Playwright `storageState` and Netscape `cookies.txt`; no third-party command-line tool.
8. **Stored cookies**: rows with count and relative expiry, a trash icon per site (tooltip), "Clear all" behind an `AlertDialog`
   confirmation, and an empty state. Existing routes are enough: `DELETE .../cookies[/<domain>]` clears one or all.
9. **Menu**: one row "Import cookies…" (cloud-upload icon, `title` explains the Google limit) that opens the dialog. The submenu
   and its note row are gone, which also removes the odd bottom-left placement; no shared menu primitive was touched.

Server changes are small: the preview adds `blocked`, and the parser accepts Cookie-Editor's `expirationDate` and `no_restriction`.
Cookie values still never appear in a response or a log line (tests use a canary).

Deliberately not built: per-site removal undo (the cookies are deleted server-side; a confirmation for "Clear all" is the safeguard),
a client-side parser or value preview, import from other browsers' stores, drag-and-drop of several files, a preview-by-cookie-name view.

Not verified without a real browser: how the dialog, the drop-zone highlight and the Collapsible chevrons look in light/dark and at
narrow widths, and the Radix focus return to the menu after close. Covered by jsdom tests: states, ARIA, focus entry, Escape rules.
