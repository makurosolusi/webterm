// Definisi env fitur Browser Canvas untuk registry Pengaturan (data murni; lihat envRegistry.types.ts).
// Nama kunci & default berasal dari `browser.contract.ts`. SEMUA fitur mati tanpa
// `WEBTERM_BROWSER=on` (impor cookie menyala otomatis bersama browser): tidak ada proses Chromium, proxy, rute, maupun jalur `/ws/browser`.
import { DEFAULT_COOKIE_TTL_DAYS, DEFAULT_DISCARD_MS, DEFAULT_MAX_LIVE, ENV_BROWSER, MAX_LIVE_RANGE } from '../../shared/browser.contract'
import { flag, num, text, type EnvSpec } from '../envRegistry.types'

const GROUP = 'browser'
// Semua 'hot': runtime browser hidup-mati lewat hook kemampuan `browser` (browser.activate.ts), tanpa restart.
const B = { owner: 'platform', section: 'Browser', audience: 'advanced', restart: 'hot' } as const
const BROWSER_ON = { key: ENV_BROWSER.enabled }
const DISCARD_MS_MAX = 86_400_000 // 24 jam
const COOKIE_TTL_DAYS_MAX = 365

export const BROWSER_ENV_SPECS: readonly EnvSpec[] = [
  flag(ENV_BROWSER.enabled, GROUP, {
    ...B,
    audience: 'user',
    dangerNote: 'Runs Chromium on the server and opens the web on your behalf; a new attack surface if pages are untrusted.',
    label: 'Browser node',
    description: 'Web pages as nodes on the canvas (Chromium on the server). Works as soon as Chrome or Chromium is found. Off = no browser process, proxy, or routes.',
    dangerous: true,
  }, 'on'),
  text(ENV_BROWSER.bin, GROUP, {
    ...B,
    requires: [BROWSER_ON],
    allowEmpty: true,
    dangerNote: 'This path is run as a process on the server machine; only enter a trusted Chromium binary.',
    label: 'Chromium binary path',
    description: 'Absolute path to Chromium/Chrome. Empty = auto-detect in common locations.',
    dangerous: true,
  }, { absolutePath: true }),
  num(ENV_BROWSER.maxLive, GROUP, MAX_LIVE_RANGE.min, MAX_LIVE_RANGE.max, DEFAULT_MAX_LIVE, {
    ...B,
    requires: [BROWSER_ON],
    label: 'Live tab limit',
    description: 'How many Browser nodes may be active at once; the oldest hidden one is paused, then discarded.',
  }),
  num(ENV_BROWSER.discardMs, GROUP, 0, DISCARD_MS_MAX, DEFAULT_DISCARD_MS, {
    ...B,
    requires: [BROWSER_ON],
    label: 'Tab discard delay (ms)',
    description: 'How long a Browser node stays hidden before its page is discarded to save memory.',
  }),
  flag(ENV_BROWSER.agent, GROUP, {
    ...B,
    requires: [BROWSER_ON],
    dangerNote: 'Terminal agents can drive the browser (click, type, navigate) with the existing login sessions; page content is untrusted.',
    label: 'Agent control',
    description: 'Terminal agents cabled to a Browser node may drive it (on by default; turn off per node with the toolbar toggle). Page content is untrusted.',
    dangerous: true,
  }, 'on'),
  flag(ENV_BROWSER.captureLinks, GROUP, {
    ...B,
    requires: [BROWSER_ON],
    label: 'Open links from terminals in the canvas browser',
    description: 'On: a link a terminal or agent opens (sign-in pages from login commands, open, xdg-open, BROWSER) appears as a tab in a Browser node on the canvas, one is added next to the terminal if none is wired. ' +
      'Off: links open in your machine browser. Applies to terminals started after the change; running ones keep their setting until restarted.',
  }, 'on'),
  flag(ENV_BROWSER.downloadsAuto, GROUP, {
    ...B,
    requires: [BROWSER_ON],
    label: 'Keep downloads automatically',
    description: 'On: files a page downloads are saved in the webterm folder of that browser profile (never your Downloads folder); "Save a copy" in the node takes one out. ' +
      'Off: each finished file waits for Keep or Discard in the node\'s downloads list. Applies to new downloads.',
  }, 'on'),
  text(ENV_BROWSER.allowHosts, GROUP, {
    ...B,
    requires: [BROWSER_ON],
    allowEmpty: true,
    dangerNote: 'Opens private networks/localhost to the server browser; pages can reach internal services.',
    label: 'Allowed private hosts',
    description: 'Comma-separated host:port list that may be opened even on a private network/localhost. Also filled by the "Allow" button on the Browser node. ' +
      'When webterm listens only on loopback, localhost (except the webterm port) is always allowed; other private networks stay blocked.',
    dangerous: true,
  }),
  flag(ENV_BROWSER.cookieImport, GROUP, {
    ...B,
    requires: [BROWSER_ON],
    dangerNote: 'Login session cookies go into the server vault and are used by the browser; only import from sources you trust.',
    label: 'Cookie import',
    description: 'Allows importing cookies from a file into the workspace browser profile (stored encrypted). Cookie values are never shown. On by default with the browser; every import still needs a preview + confirmation.',
    dangerous: true,
  }, 'on'),
  num(ENV_BROWSER.cookieTtlDays, GROUP, 1, COOKIE_TTL_DAYS_MAX, DEFAULT_COOKIE_TTL_DAYS, {
    ...B,
    requires: [BROWSER_ON],
    label: 'Stored cookie lifetime (days)',
    description: 'Cookies in the vault are discarded automatically this many days after import.',
  }),
  flag(ENV_BROWSER.accounts, GROUP, { ...B, requires: [BROWSER_ON], label: 'Show signed-in accounts for browser profiles',
    description: 'On: each profile shows who is signed in to Google and GitHub (name, masked email), checked inside that profile only when it opens, after a login, or on Refresh. Off: nothing is checked or shown. Cookies and full emails are never stored or shown.',
  }, 'on'),
  flag(ENV_BROWSER.audio, GROUP, { ...B, requires: [BROWSER_ON], label: 'Browser audio', description: 'Streams browser node sound to the canvas, captured inside the page and only while a client listens; the server stays silent. Off = no audio capture.' }, 'on'),
  flag(ENV_BROWSER.headless, GROUP, {
    ...B, requires: [BROWSER_ON],
    label: 'Headless mode',
    description: 'Force headless Chromium. Off by default: a real off-screen window, so sites don’t flag it as a bot. Linux without a display is headless automatically.',
  }),
]
