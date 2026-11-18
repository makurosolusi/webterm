# Browser profile accounts ("who is signed in")

Status: implemented on `feature/browser-profile-accounts`. Providers: Google and GitHub only.

## Why

A browser node showed its login only after you opened a page (avatar vs. Login button). With several profiles (see
`browser-profiles.md`) that means opening each one to learn which account lives where. Now the profile chip, its menu and
Settings > Browser say "Google · name · b***@gmail.com" or "Not signed in" without opening any page, and agents learn
which profile already holds which login (so they stop logging in again or picking the wrong profile).

## Model (`src/shared/browser.accounts.ts`)

`ProfileAccount { provider, state, displayName?, emailMasked?, avatarUrl?, checkedAt }`, `state` = `signed_in | signed_out |
expired | unknown`. Providers are a data table (`ACCOUNT_PROVIDERS`: id, label, cookie domains that make a profile a
candidate, the one probe URL, allowed avatar hosts) plus one parser each in `browser.accounts.parsers.ts`
(`ACCOUNT_PARSERS`). Adding a provider = a row + a parser + tests; nothing else. Only Google and GitHub exist.

`maskEmail` keeps the first letter and the domain (`b***@gmail.com`). The full address is masked at the parser, so it never
exists past it: not in memory caches, files, API answers, logs, briefings or UI. `validateAccount` re-masks anything that
looks like a full address and drops avatars outside the provider's own https hosts.

## How a check works (`browser.accounts.service.ts`, `.probe.ts`)

1. Only for a profile whose Chromium process is **already running** (`launcher.isLive`). A check never launches a browser.
2. Browser-level CDP (like the cookie injector) lists cookie **domains** only (`Storage.getCookies`; names and values are
   dropped on the spot). A provider is asked only when the profile holds a cookie on its domain; otherwise the answer is
   `signed_out` with zero requests.
3. For a candidate, ONE hidden tab is created in that same Chromium (`Target.createTarget`, background, no opener, so the host
   ignores it), navigates to the provider's probe URL, a page script reads a bounded set of facts, the tab is closed. Cookies
   therefore go only to the provider's own domain, through the same SSRF proxy and the navigation guard as every page; no
   separate HTTP client ever sees a cookie.
4. The result is parsed defensively. Anything not recognised is `unknown` (never a guess, never an error).

### Per provider (unofficial surfaces, they can change)

- **Google**: `https://accounts.google.com/ListAccounts?json=standard&source=ChromiumBrowser&gpsia=1`, the listing Chromium
  itself uses to learn the signed-in accounts. Shape: `["gaia.l.a.r",[[ "gaia.l.a", 1, name, email, avatar, ..., valid(9),
  gaiaId(10), ..., signedOut(14) ]]]`. Verified against Chromium's `google_apis/gaia/gaia_auth_util.cc` (email at index 3,
  valid flag at 9 meaning `expired` when 0, signed-out flag at 14). Name (2) and avatar (4) positions are best effort (not in
  that file); a wrong index gives no name, not a wrong state. Empty list or all signed-out = `signed_out`; only invalid
  entries = `expired`; the first valid one (the browser's default account) is shown. A redirect to a sign-in page = `unknown`.
- **GitHub**: the page `https://github.com/`, `<meta name="user-login">`: non-empty = signed in as that login (validated
  against GitHub's login charset), empty = signed out, **tag missing = `unknown`** (markup changed). `api.github.com/user` is
  not used because it ignores browser cookies. GitHub shows no email here, so the login is the name. Not verified against a
  signed-in page in this change (public search results only confirm the tag exists and is empty when signed out).

**This can change.** Neither surface is a public contract. When one changes, the parser returns `unknown`, the UI says
"Unknown", and only a parser fix restores it. Tests use fixtures of the documented shapes, never the network.

## Politeness: no CAPTCHAs

No timer and no polling. Triggers (`browser.runtime.accounts.ts`): the profile's process comes alive (a node attaches), cookies
were imported into it, a tab of that profile reached a provider host (once the page stopped loading; arriving from or on a
login/logout/account page counts as a session change and uses the 15 s floor instead of the TTL), and the profile menu
opening on data older than the TTL. Limits: TTL 10 min per profile + provider (`ACCOUNT_CHECK_TTL_MS`), at most one check per
profile at a time (callers join the one in flight), Refresh skips the TTL but keeps a 15 s floor, no retries. A page that
looks like a human check or rate limit (captcha, "unusual traffic", `/sorry/`, "too many requests", "rate limit") is read as
`challenge`: the state becomes `unknown` and that provider is not asked again until a backoff of TTL x 2^hits (cap 6 h) has
passed. Nothing is typed, clicked or solved; the page is only read, in line with `browser.challenge.ts` (a human check is the
user's).

## Where it lives and what is stored

In memory plus `<dataDir>/browser/accounts/<profileId>.json`, mode 0600, rebuilt through `validateAccounts` on load. It is
not in the workspace SQLite tables (so `db.ts` and the preserve-nodes guard are untouched) and is removed with the profile.
Logs carry provider + state + profile id only (no name, no email, no cookie, no login).

## Setting

Settings > Browser card, switch **"Show signed-in accounts for browser profiles"** (`WEBTERM_BROWSER_ACCOUNTS`, default ON,
approved by the owner). Off = no check runs, the list carries no `accounts`, and `GET /api/browser/profiles` answers
`accountsEnabled: false` so every client hides the dot, the menu section and the Settings lines.

## API / protocol

- `BrowserProfile.accounts?` on the list; `ProfileListResp.accountsEnabled?`.
- `POST /api/browser/profiles/:id/accounts/refresh` (human UI gate only, node tokens have no path to it): skips the TTL; the
  menu sends `?popover=1` when it merely opened, which keeps the TTL. Answer `{ accounts }`. A non-running profile answers
  its last known accounts.
- No new WS event: a changed answer broadcasts the existing `browserProfiles` frame.

## UI

Chip: small green dot when an account is signed in (tooltip and aria-label say so; tooltip ends with the summary, "Not signed
in" or "No accounts detected"). Menu section "Accounts in this profile": a row per account (provider icon, name, masked
email, hover text with state and "checked N min ago"), Session expired / Unknown rows, "Not signed in", "No accounts detected",
"Checking accounts…", a Retry row on failure, and "Refresh accounts" (the menu closes on pick, so the result is one notice, with
Retry on failure). Settings: a line per account under each profile row and a Refresh button with the shared action feedback
(busy, result line, failure toast); a profile with no running browser shows why there is no button. Generic icons only, no brand
logos.

## Agents (`web.profiles` in `agentCapabilities.data.ts`)

The capability text says a profile lists who is signed in (masked), and `webterm browser profiles` and Central's
`browser_profile` / `browser_status` profile views add `accounts` (provider, state, displayName, emailMasked), via
`agentAccountView` (no avatar, no time; the third-party name is clipped to 40 characters and the tool text says names are
untrusted). Agents never get cookies or full addresses.

## Threat model

- Personal data (a name, a masked email) stays on this machine, 0600, and is shown only behind the UI gate. Agents see the
  masked form and a clipped name.
- No cookie value leaves the browser vault or the Chromium process. The check reads cookie domains, not values.
- The check only talks to the provider's own domain, through the SSRF proxy and the navigation guard.
- A malicious display name is third-party text: clipped, control characters removed, rendered as text, flagged untrusted for
  agents.
- Requests are rare and bounded (TTL, serial, floor, backoff), so the check does not look like automation to the provider.

## What it does not detect

Other providers; which of several Google accounts is "active" beyond the default listed first; accounts signed in only in
an app of the profile that does not use these cookies; a signed-in state whose cookies exist but a provider page changed
(`unknown`); a profile with no running browser (last known answer, or nothing). GitHub: no email, no expiry (expired
sessions read as signed out).

## Not verified without a real browser

Both probe pages against the live providers (shape per above, documented sources only), the hidden tab not stealing focus or
showing in the screencast, and how the dot, menu rows and Settings lines look in both themes.
