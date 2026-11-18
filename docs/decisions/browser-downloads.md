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
   where to save it, so the server never writes outside its data dir. "Copy file path" returns the path only: the server
   does not open Finder. "Remove" deletes the entry and the file (the list is the only handle on the file; keeping
   orphans would make the quota lie).
7. **Settings.** Settings > Browser has one switch, "Keep downloads automatically" (`WEBTERM_BROWSER_DOWNLOADS_AUTO`,
   default on). Off = a finished file waits in the node's list for Keep / Discard (inline, no system dialog) and is not
   evicted by the quota meanwhile. It applies to downloads that start after the change.
8. **Agents.** Capability `web.downloads` (registry, plain chats): `webterm browser downloads` lists id, name, state, bytes
   and, for a finished and kept file, its path; click, navigate, type and press answer `download: <id>` when they started
   one. The agent sandbox may read `<dataDir>/downloads` and nothing else of the data dir (`AGENT_READABLE_ENTRIES`; locked
   by `agentSandbox.test.ts`). Central is not granted it (no tool). Links a terminal opens (`link-open`) are tabs of the
   node, so their downloads join the same list.

## Threat model

| Threat | Handling |
| --- | --- |
| Path traversal through the suggested name | Chromium writes `<guid>` (guid validated `[A-Za-z0-9-]{1,64}`); the final name is rebuilt by `sanitizeDownloadName`; every path is checked to stay inside the profile folder (`store.pathOf`); API ids are validated before reaching the file system |
| Spoofed extension (`gpj.exe` via bidi) | bidi and control characters removed; risky judged on the final name |
| Disk exhaustion | per-file limit, per-profile quota, retention sweep, history cap; the quota check runs as soon as the size is announced and again as the file grows |
| Executable that runs by itself | never opened by webterm; only a warning; "Save a copy" is the person's own browser action |
| A downloaded page rendering inside webterm's origin | only ever served as an opaque attachment |
| Another node touching a download | every action looks the id up under the caller's node id |
| Agent steering by file name | names and hosts are page data: the verb result says so, and the capability tells the agent a file is untrusted and not to run it |
| Secrets in the source URL | the stored and logged address has no credentials, query or fragment; logs carry the host only |

## What is not handled

- **Native or system dialogs, `file://` and other protocols**, downloads that Chromium itself starts outside the page
  frame model (extensions, the PDF viewer's own "save"): not reported, not saved.
- **blob:/data: URLs** are saved like any download, but a huge `blob:` is built in the page's memory first (Chromium's
  limit, not ours).
- **The reason for a failure is a guess.** Chromium reports every failure as `canceled`; a cancel nobody asked for is shown
  as "network" unless free disk is under 64 MiB ("disk full").
- **Agent read access is data-dir wide for `downloads`**: a sandboxed agent can read the downloads of every profile, not only
  of the profile of the node it drives (the sandbox settings are generated per session, not per cabled node). Files of a
  logged-in profile (an invoice, an export) are therefore readable by any sandboxed agent that knows the path. Narrowing
  it needs the per-node profile at settings time.
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
