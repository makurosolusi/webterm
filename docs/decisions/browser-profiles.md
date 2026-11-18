# Browser profiles

Status: server side implemented (feature/browser-profiles-server). UI and Central tools follow in separate waves.

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
