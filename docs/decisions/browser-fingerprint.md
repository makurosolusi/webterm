# Browser node: does it look like a normal Chrome? (Google /sorry captcha)

Date: 2026-11-18. Branch `fix/browser-looks-automated`.

## Symptom

A browser node showed `https://www.google.com/sorry/index?continue=...search?q=detik` with a reCAPTCHA
("Our systems have detected unusual traffic from your computer network"). The owner had not seen it before and
never sees it in another Chromium-based browser on the same machine and IP.

## Method

Real Chrome 157 (`/Applications/Google Chrome.app`), temp profile and data dir, mock keychain, no leftover processes.

- **A (control)**: Chrome with a fresh profile and only `--remote-debugging-port` (needed to read values). No proxy, no override.
- **B (webterm)**: the production path: `buildChromiumArgs` + `launchChromium` + SSRF proxy + `setupConnection` +
  `createPageTarget` (offscreen window, metrics/focus emulation, permission denial).
- Values read with `Runtime.evaluate`; request headers read by a local server that echoes `rawHeaders`.
- Public fingerprint pages: `bot.sannysoft.com`, `abrahamjuliot.github.io/creepjs` (one load each per config).
- Google: one manual navigation per config to `/search?q=detik` (same IP, seconds apart). No more, by design.

Scripts were throwaway; the durable checks are the tests listed at the end.

## A vs B, row by row

"Same" = identical value in both. Rows that differ are candidates.

| # | Signal | A (plain Chrome) | B (webterm) | Verdict |
|---|---|---|---|---|
| 1 | `User-Agent`, `sec-ch-ua*` headers, order, `Accept`, `Accept-Language`, `Sec-Fetch-*`, `Accept-Encoding` | `Chrome/157`, `en-US,en;q=0.9`, ... | same | same |
| 2 | `navigator.userAgentData` brands/platform/mobile/high entropy | Google Chrome 157, macOS, arm | same | same |
| 3 | `languages`, `Intl` locale, timezone | `en-US,en`, `en-US`, `Asia/Makassar` | same | same (the owner's own Chrome also runs `--lang=en-US`) |
| 4 | plugins (5), mimeTypes (2), `window.chrome` keys | present | same | same |
| 5 | WebGL vendor/renderer, cores, memory, colorDepth, fonts | Apple M1 via ANGLE Metal | same | same |
| 6 | headless markers | `headlessUA` false | false | same |
| 7 | CDP detection (`Runtime.enable` stack trap) | not triggered | not triggered | same (console capture enables `Runtime.enable` only when used) |
| 8 | cookies set and sent between navigations | stored, sent | stored, sent | same |
| 9 | **F1** `navigator.webdriver` | `true` | `false` | differs, **deliberate**: `--disable-blink-features=AutomationControlled` |
| 10 | **F2** `Notification.permission`, permissions query | `default` / `prompt` | `denied` | differs, intentional (see below) |
| 11 | **F3** `devicePixelRatio` | 2 (Retina) | 1 (`DEFAULT_VIEWPORT.dpr`) | differs, not proven relevant |
| 12 | `hasFocus()`, `visibilityState` | false / hidden (background window) | true / visible (focus emulation) | B looks more like a foreground window |
| 13 | inner/outer/screen size | 1200x744, outer 0x0 | 1280x800, outer 1280x800 | B is self-consistent |
| 14 | request headers, plain `http://` through the proxy | `Connection: keep-alive` | `Connection: close`, lower-cased names | differs, **http only**, never HTTPS (P2) |
| 15 | sannysoft | `WebDriver (New): present (failed)` | nothing failed | B passes more |
| 16 | CreepJS headless score | 33% headless, 25% like-headless | 0% headless, 38% like-headless | no meaningful difference (A hidden window vs B emulated focus) |
| 17 | Google `/search?q=detik` (one navigation each, same IP) | **`/sorry/index` captcha** | normal results | see root cause |

Conclusion of the table: nothing in how webterm launches Chrome makes the page-visible client **less** like Chrome
than the control. The control, with a plain Chrome, received the same `/sorry/` page.

## Webterm-only findings (not visible in A vs B)

| # | Where | Finding | Evidence | Action |
|---|---|---|---|---|
| S1 | Shields (`adblock.engine`, EasyPrivacy lists) | On a google.com page the filter list **blocks Google's own first-party beacons**: `www.google.com/gen_204`, `/client_204`, `/log`. A real Chrome sends them, so a Shields-on node was missing telemetry Google expects. It can also block verification widgets. | Engine verdicts from the real cached list (script run against `adblock-engine.bin`): gen_204 and client_204 `BLOCK` (rule `/client_204?` + `/gen_204?`), `/log` `BLOCK`, recaptcha, `consent.google.com`, `/sorry`, gstatic, hCaptcha and Turnstile `pass` | **Fixed**: `adblock.exempt.ts` (Google first-party on a Google page, reCAPTCHA/hCaptcha/Turnstile always). Causal link to the captcha is **not proven**. |
| P1 | SSRF proxy `CONNECT` | Blind byte pipe (`upstream.pipe(client)`), TLS is end to end: the TLS/HTTP2 fingerprint a site sees is Chrome's own. Destination IP is validated through the same DNS lookup. | Read `ssrf.proxy.ts`; new test sends a ClientHello-shaped binary and gets it upstream byte for byte | Locked by test. No change. |
| P2 | SSRF proxy plain `http://` | Absolute-URI requests are re-serialised by Node `http` (header case, `Connection: close`). Only `http://`; Google, captcha and every https site are untouched. | Rows 14, local echo | Left as is (cannot be done by a blind pipe without losing the SSRF check on the request line). |
| D1 | Device presets (explicit device mode only) | Chromium presets (Pixel 8, Galaxy S23, Surface Pro) sent `Chrome/150` in `User-Agent` but `"Google Chrome";v="157"` in `sec-ch-ua`: UA and Client Hints disagreed. | Real Chrome, before/after | **Fixed**: version comes from `Browser.getVersion`; brands, full version list, `fullVersion` consistent. A non-Google Chromium is never labelled "Google Chrome". |
| D2 | Device presets | `navigator.platform` stayed `MacIntel` for Android/Windows/iOS presets (DevTools sets it with the UA). | Real Chrome | **Fixed**: `navPlatform` per preset (`Linux armv81`, `Win32`, `iPhone`, `iPad`). |
| D3 | iOS presets | The engine is still Chromium, so `navigator.userAgentData` exists with empty brands, unlike Safari. Hiding it needs injected JS, which is out of bounds. | Real Chrome | **Not fixed, by design.** Device mode is an explicit emulation. |
| C1 | Cookies / profile | Profile dir is per workspace under the data dir and persists; the only `Storage.clearCookies` is the explicit cookie import. Session cookies end with the Chromium process, as in any Chrome. | Read `browser.cookieInjector.ts`, `chromium.launch.ts`; row 8 | No change. |
| L1 | Locale | Webterm sets no `--lang`, locale or timezone override: it follows the system (`en-US`, `Asia/Makassar`), same as A. | Rows 3 | No change. |
| W1 | WebRTC | `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` did not stop a STUN server-reflexive candidate (public IP) in either A or B on this Chrome. Unrelated to the captcha; recorded as a side observation for the owner. | CreepJS WebRTC section | Out of scope here. |
| E1 | Other flags | `--disable-extensions`, `--disable-component-update`, `--disable-background-networking`, `--no-first-run`, window flags: no page-visible difference in rows 1-8. | Table | Kept. The launch line is now a closed list (test). |

### Why F2 stays

`Notification.permission` is `denied` because nothing can answer a permission prompt in an offscreen window
(`--deny-permission-prompts` + `Browser.setPermission`). Leaving `default` would leave a prompt nobody sees.

### F1: needs the owner's decision (not changed)

`--disable-blink-features=AutomationControlled` makes `navigator.webdriver` read `false` while a CDP port is open.
It is the one remaining flag whose purpose is to hide an automation signal, which sits badly with "behave like
Chrome and be honest". It was added on purpose (the comment in `chromium.flags.ts`), so it was not removed
without a decision. Evidence: A (webdriver `true`) got the captcha and B (`false`) did not, but that is one
navigation each from one IP, so it proves nothing either way. Removing it is one line plus the two tests that
assert `webdriver === false`; expect sites that look at the flag to challenge more, not less.

## Root cause

**Not proven to be webterm.** The control browser got the same Google captcha, so the measured differences
cannot explain it. What is left:

1. **IP / traffic reputation** at Google (shared ISP address, recent automated-looking searches from this
   machine). Google's decision is not observable from here.
2. A **fresh profile**: no `NID`/`SOCS`/`AEC` history, queries opened straight at `/search?q=` with no referrer.
3. **S1** (blocked beacons) is a plausible contributor on Shields-on nodes; fixed, effect not measurable.

No claim that the captcha is gone. It can come back for reasons that live outside webterm.

## What changed

| Change | Row |
|---|---|
| Shields never filter Google first-party traffic on a Google page, nor reCAPTCHA/hCaptcha/Turnstile | S1 |
| Device presets: real engine major in UA and Client Hints; `navigator.platform` per preset | D1, D2 |
| Human-check handling (below) | product |
| Tests: closed launch-flag list, proxy blind pipe, real-Chrome consistency, Shields exemption | P1, E1 |

## Human check handling (product, no evasion)

The node does not solve or sidestep a check. It says so and hands it to the person.

- `shared/browser.challenge.ts` classifies the **main-frame** URL and title: Google `/sorry/`, reCAPTCHA, hCaptcha,
  Cloudflare, "Just a moment...", "Verify you are human". A widget inside an ordinary page is not a challenge.
  `state.challenge = {kind, url}` carries origin + path only (the `/sorry` query holds the search terms).
- UI: `BrowserChallengeBanner` ("This site is checking that you're human. Solve it here; agents are paused until you
  continue.") with "I'm done" (`challengeDone` message), which makes the node stop flagging that page.
- Agent: while `state.challenge` is set, every verb except `status`, `tabs`, `release` answers `409
  human_verification_required` with `next: "Ask the user to solve the check in the browser node, then continue; do
  not retry."`. After 3 refused calls `next` becomes "Stop calling browser verbs on this node." The lease is
  released to the user as soon as the check appears. `browser_read` returns the same code.
- Capability registry: one sentence ("If a page asks you to verify you are human, stop and ask the user to
  complete it in the browser node.") in `agentCapabilities.data.ts`, rendered into the steward and chat.default
  briefings and the skill-author profiles.

## Tests

`adblock.exempt.test.ts`, `browser.challenge.test.ts`, `browserHost.challenge.test.ts`,
`browserControl.challenge.test.ts`, `BrowserChallengeBanner.test.tsx`, `browserHost.device.identity.test.ts`,
`chromium.flags.closed.test.ts`, `ssrf.proxy.bun.test.ts` (blind pipe), `browser.fingerprint.real.bun.test.ts` (real Chrome).
