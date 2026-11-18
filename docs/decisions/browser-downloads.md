# Browser downloads: files stay on the canvas, taking one out is a deliberate act

## Problem

A download from a page in a browser node did nothing and said nothing: `setupConnection` called
`Browser.setDownloadBehavior { behavior: 'deny' }` for every connection. Root cause: the host had no download model at all,
so the only safe setting was "refuse". The owner's rule is that anything the canvas starts stays on the canvas, so the fix
is not "allow and let Chromium write to ~/Downloads": the file must land in a webterm folder, be visible in the node, and
leave only when the person says so.

## Decision

1. **Where.** `Browser.setDownloadBehavior { behavior: 'allowAndName', downloadPath: <dataDir>/downloads/<profileId>/,
   eventsEnabled: true }`, set once per CDP connection. A connection is one Chromium process = one profile, so the
   folder is per profile without any `browserContextId`. Folder 0700, files 0600, `index.json` (metadata) 0600.
   `allowAndName` makes Chromium write `<guid>`; the page never chooses a path. When a download ends the host renames
   `<guid>` to a safe, unique name (`browserHost.downloads.ts`, `browser.downloads.store.ts`).
2. **Model.** `src/shared/browser.downloads.ts` is a pure reducer (begin, progress, done, fail, pending, missing, remove),
   shared by server and client. The server keeps the list in memory and in `index.json` per profile (not the workspace
   SQLite: history is disposable, and the DB write rules stay untouched). After a restart nothing is "running"
   (interrupted) and a file that vanished is `missing`.
3. **Events.** `Browser.downloadWillBegin` / `downloadProgress` are mapped to node and tab (a main frame id is its target
   id; an iframe falls back to a live node of the profile; no node = the download is canceled instead of kept invisibly).
   The node's viewers get `{t:'download'}` per change and `{t:'downloads'}` on attach and after a removal. Progress is
   throttled to 4 per second per download (`DOWNLOAD_PROGRESS_MIN_INTERVAL_MS`); begin and end always pass. No polling.
4. **Limits (named constants in `browser.downloads.ts`).** 50 entries per node, 2 GiB per file, 8 GiB of finished files per
   profile, 14 days of retention (hourly sweep). Over the per-file limit the download is canceled and shown as failed
   ("over the size limit"). A download that does not fit the quota first removes the oldest finished files (never one
   that waits for Keep / Discard, never a running one); if it still does not fit it is refused ("quota is full").
   The bytes go from Chromium straight to disk; nothing is read into webterm's memory.
5. **Names.** The suggested name is untrusted: path separators and traversal are cut, control and bidi characters
   removed, `: * ? " < > |` replaced, leading dots and trailing dots/spaces trimmed, length bounded, empty = `download`;
   a clash becomes `name (1).ext` (case-insensitive). Names read back from `index.json` are sanitized again. Executable
   types (`.app .exe .sh .pkg .dmg .bat .command ...`, judged by the last extension) are marked `risky`: a warning icon
   with a tooltip. Nothing is blocked: the person chose the download.
6. **Taking a file out.** "Save a copy..." is a link to `GET /api/browser/:node/downloads/:id/file`, answered as an opaque
   attachment (`application/octet-stream`, `Content-Disposition: attachment`, `nosniff`); the person's own browser asks
   where to save it, so for a person the server never writes outside its data dir (the only exception is an agent's `downloads copy`, below). "Copy file path" returns the path only: the server
   does not open Finder. "Remove" deletes the entry and the file (the list is the only handle on the file; keeping
   orphans would make the quota lie).
7. **Settings.** Settings > Browser has one switch, "Keep downloads automatically" (`WEBTERM_BROWSER_DOWNLOADS_AUTO`,
   default on). Off = a finished file waits in the node's list for Keep / Discard (inline, no system dialog) and is not
   evicted by the quota meanwhile. It applies to downloads that start after the change.
8. **Agents.** Capability `web.downloads` (registry, plain chats and Central). A terminal agent: `webterm browser downloads` lists
   id, name, state and bytes (no path); `downloads read <id>` prints a finished text file (first 64 KiB, `truncated` says
   so; a binary file is refused with the way to take it); `downloads copy <id> <name>` saves it as `<name>` in the agent's
   own working directory. click, navigate, type and press answer `download: <id>` when they started one. The agent
   sandbox may NOT read `<dataDir>/downloads` (see "Scope of agent access" below). Central: read-only tool `browser_downloads`
   (metadata: id, name, state, size, host, node, profile; filter by node or profile); it never reads file contents. Links a
   terminal opens (`link-open`) are tabs of the node, so their downloads join the same list.

## Scope of agent access: the profile of the cabled browser, enforced per call

**Problem.** The first version let the sandbox read the whole `<dataDir>/downloads` (every profile). Settings are generated
when a session starts, but a cable can be added or removed later, so no per-profile path list in the settings can be right.
A file of a logged-in profile (an invoice, an export) was readable by any sandboxed agent that knew its path.

**Decision: serve the file through the server, check the cable on every call, and take `downloads` out of the sandbox.**

- The `downloads` verb resolves its browser node exactly like every other browser verb (`browser.linkedTarget.ts`: the
  caller's token names the agent node, its live cables name the browser nodes, `--node` picks one of them). `read <id>` and
  `copy <id>` then look the id up in THAT node's own list (`HostDownloads.list(nodeId)` / `file(nodeId, id)`), which is
  the node -> profile folder mapping. An id of another node or profile is simply unknown (`download_not_found`), so there is
  no path from an agent to a profile that is not cabled to it, and a cable removed a moment ago stops working at once.
- `<dataDir>/downloads` moved from `AGENT_READABLE_ENTRIES` to `AGENT_SECRET_ENTRIES`: unreadable and unwritable for the
  sandbox, and `Read` is denied by the permission rules even where there is no sandbox (Linux, sandbox off).
- Why not a per-profile allowRead computed at session start: a cable added later would not be readable (bad), one removed
  later would stay readable (worse), and the settings file is not rewritten while a session runs. Why not a Chromium-side
  copy per session: the bytes would be duplicated for no gain. Why not raw bytes over HTTP: the control API answers JSON only,
  a 2 GiB file does not belong in a JSON body, and an agent that needs the bytes uses `copy`.
- `copy` is the one place the server writes for an agent. It writes only into the caller's working directory, which the
  server decides from the proven caller (its node `cwd`, else its board's) and writes into the verb body itself, so a
  `cwd` sent by the caller is overwritten; Central has none and gets `no_agent_cwd`. The destination is a plain relative
  name: no absolute path, no `..`, no hidden (dot) name (so never `.git/hooks`, `.claude`, `.env*`, which the sandbox
  protects from the agent but not from the server), the folder must already exist and resolve (symlinks followed) inside the
  working directory, and an existing file or symlink is never overwritten.
- Error codes (wire name, status): `bad_download_id` 400, `download_not_found` 404, `download_not_ready` 409,
  `download_missing` 404, `download_binary` 415, `bad_destination` 400, `destination_exists` 409, `no_agent_cwd` 400,
  `copy_failed` / `download_unreadable` 500; each carries a message and a `next` step.
- Why Central gets metadata only: file text from the web would enter the model unquarantined (`browser_read` exists to keep
  page text out of it), and Central writes no code and runs no file. A terminal agent wired to the browser does the reading.

## Threat model

| Threat | Handling |
| --- | --- |
| Path traversal through the suggested name | Chromium writes `<guid>` (guid validated `[A-Za-z0-9-]{1,64}`); the final name is rebuilt by `sanitizeDownloadName`; every path is checked to stay inside the profile folder (`store.pathOf`); API ids are validated before reaching the file system |
| Spoofed extension (`gpj.exe` via bidi) | bidi and control characters removed; risky judged on the final name |
| Disk exhaustion | per-file limit, per-profile quota, retention sweep, history cap; the quota check runs as soon as the size is announced and again as the file grows |
| Executable that runs by itself | never opened by webterm; only a warning; "Save a copy" is the person's own browser action |
| A downloaded page rendering inside webterm's origin | only ever served as an opaque attachment |
| Another node touching a download | every action looks the id up under the caller's node id |
| An agent reading a profile that is not cabled to it | no path: the sandbox cannot read `downloads`; `read`/`copy` resolve the id under the node the cable names at call time (`download_not_found` otherwise) |
| `copy` used to plant a file (`.git/hooks`, `.claude/settings.json`, outside the cwd, over an existing file) | relative, dot-free, existing folder inside the realpath of the server-decided cwd, `COPYFILE_EXCL` |
| Agent steering by file name | names and hosts are page data: the verb result says so, and the capability tells the agent a file is untrusted and not to run it |
| Secrets in the source URL | the stored and logged address has no credentials, query or fragment; logs carry the host only |

## What is not handled

- **Native or system dialogs, `file://` and other protocols**, downloads that Chromium itself starts outside the page
  frame model (extensions, the PDF viewer's own "save"): not reported, not saved.
- **blob:/data: URLs** are saved like any download, but a huge `blob:` is built in the page's memory first (Chromium's
  limit, not ours).
- **The reason for a failure is a guess.** Chromium reports every failure as `canceled`; a cancel nobody asked for is shown
  as "network" unless free disk is under 64 MiB ("disk full").
- **Sessions started before this change** keep the sandbox settings they were generated with (which still allowed reading
  `downloads`) until they end; no new session can read it. A running agent's old briefing also still names the path form;
  the "Capabilities updated" note covers the changed wording once the hash differs.
- **`copy` lands in the node's configured working directory.** An agent that works in another directory (a worktree it
  changed into) finds the file under its node's `cwd`; `read` has no such dependency.
- **`read` returns text only**, 64 KiB at most; PDFs and images are taken with `copy` and read by the agent's own tools.
- **Unverified against a real Chromium in this change.** `allowAndName` naming and the event shapes follow the CDP
  reference and are exercised against a fake CDP server only; a real download smoke test is still to run.
- **Resume after a restart** and parallel-download limits are not implemented; an interrupted download is shown as failed.

## Placement

The Downloads control lives in the address toolbar, not the node title row (Chrome/Edge/Arc): on the right, after the
omnibox and the Shields / console / Agents controls and immediately before the ⋮ menu. It appears once the node has any
download (running or in the list) and its width animates in (no animation under reduced motion), so the address field does
not jump. With no history the button is hidden and the ⋮ menu "Downloads" row opens the same list, anchored at the same
spot. In a narrow node (container width <= 260px) the button collapses and the ⋮ row stays the way in. The popover is
right-aligned to the anchor and clamped to the window.
