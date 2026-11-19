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


## Google showed "Unknown" while signed in (fix: `fix/browser-google-account-detect`)

Symptom: Google page shows the avatar, GitHub reads fine, the chip menu says "Google · Unknown", Refresh changes nothing.

Reading: `unknown` is only ever produced when the probe page answered with something the parser did not accept (or never
rendered), so the cookie gate passed and the probe ran. GitHub and Google share that whole path; they differ only in WHAT
is read: GitHub = an HTML page and one `<meta>` read from the DOM; Google = a JSON endpoint rendered as text and parsed.
Hypotheses, in order of likelihood (none could be proven without the owner's live profile):

1. **Response format (possible, most likely).** Current Chromium parses ListAccounts as a base64 protobuf
   (`gaia_auth_util.cc` `ParseListAccountsData`, no prefix handling); the old `json=standard` array is the legacy shape and
   may no longer be served, or wrapped. The parser accepted only a bare array or a `)]}'` prefix. Now tolerant of
   HTML/`<pre>`/`<script>` wrappers; a protobuf answer still gives `parse_failed`. **Temporary mitigation**, not a fix of
   the identity surface.
2. **Download (possible).** Since the downloads feature the host sets `Browser.setDownloadBehavior allowAndName`; a response
   served as a file never renders, the tab stays `about:blank` and the readiness loop timed out silently. Now
   `Page.navigate`'s `isDownload` gives `probe_download`, and a timeout gives `probe_timeout`.
3. **Challenge backoff (possible, explains "Refresh does nothing").** A human-check page set `unknown` and a backoff of up
   to 6 h; Refresh was held by it. Manual Refresh now skips the automatic backoff.
4. **Guard / adblock (unlikely).** The probe passes the same navigation guard as pages; `accounts.google.com` is the
   user's own sign-in domain. Now reported as `probe_blocked` if it happens.
5. **Cookie gating (ruled out as the cause).** The check reads the profile's own Chromium cookies via CDP (not the vault), so a
   login done by hand counts, for Google and GitHub alike.
6. **Stale cached `unknown` (partly).** The answer is rewritten on every check; the only thing that persisted was the backoff.
   A newly appearing session cookie now clears it.

## Layers added

- **Session signal (no network, robust).** Names (never values) of the profile's cookies are read through CDP. Google lists
  its auth names (`SID`, `__Secure-1PSID`, `__Secure-3PSID`, `SAPISID`, `__Secure-1PAPISID`, `__Secure-3PAPISID`, `LSID`; from
  public knowledge, **not verified against a live profile**). One of them present = `signed_in`, none = `signed_out`
  with zero requests. GitHub keeps domain gating and has NO cookie fallback (anonymous visitors hold cookies there, so
  a name list would need live verification); its `unknown` stays `unknown`.
- **Identity on top.** The probe still runs (TTL, serial, backoff unchanged for automatic checks). Success adds name/masked
  email. Any failure for Google (unreadable, redirected, empty list, challenge, throw) keeps `signed_in` with no name
  (and keeps a name read earlier) and a `reason`. An empty ListAccounts list is not trusted as signed out.
- **Reasons.** `ProfileAccount.reason`: `probe_blocked`, `probe_download`, `probe_failed`, `probe_timeout`, `parse_failed`,
  `redirected`, `empty_list`, `challenge`, `cookies_unreadable`, `identity_unavailable`. Menu/Settings row: "Google · Unknown
  — couldn't parse the response"; hover has the full text. Logged as provider + state + reason + profile id only.
- **Refresh.** Manual Refresh ignores the automatic backoff (still serial per profile, 15 s floor); the popover and
  navigation triggers do not. A session cookie appearing (login) clears the backoff for that provider.
- **Not done:** reading the body with `Network.loadNetworkResource`/same-origin fetch instead of the rendered DOM; no
  evidence yet that rendering is the problem. Revisit if live `reason` shows `parse_failed` on a JSON-looking page.
- Agents: a nameless `signed_in` reads "Google: signed in" (`describeAccount`); no reason is sent to agents.

What to look at on a live profile: chip menu row for Google. "Signed in" (maybe with a name) = the session layer works;
"Unknown — <reason>" names the failing path; "Signed in" without a name plus a hover reason = identity surface is the
broken part (hypothesis 1 or 2).
