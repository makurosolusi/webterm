// Semua teks UI toolbar/chip/dialog cookie browser di satu tempat (satu sumber untuk komponen + test).
import type { UrlRejectReason } from '../shared/browser.url'

export const TOOLBAR_TEXT = {
  group: 'Browser navigation',
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  stop: 'Stop loading',
  urlLabel: 'Address',
  urlPlaceholder: 'Search or enter address',
  agentControl: 'Let agents drive',
  agentControlHint: 'On by default: terminal agents cabled to this browser can control it right away. Uncheck to turn this off.',
  agentPill: 'Agents',
  agentPillHint: 'Terminal agents cabled to this browser can drive it: click to turn this off',
  agentPillHintOff: 'Agents cabled to this browser cannot drive it: click to let them',
  agentPillDriving: 'An agent is driving this browser now',
  more: 'More actions',
  menu: 'Browser actions',
} as const

/** Tooltips of the icon-only toolbar buttons: what the click does, plus why when disabled. */
export const TOOLBAR_TIP = {
  back: 'Go back one page', backOff: 'no earlier page',
  forward: 'Go forward one page', forwardOff: 'no later page',
  reload: 'Reload this page', stop: 'Stop loading this page',
  more: 'Zoom, device mode, Shields, Design Mode, cookies and more',
} as const

/** Site-info icon at the start of the address field, picked from the page URL scheme (like Chrome's). */
export const SITE_INFO_TEXT = {
  secure: { label: 'Secure connection', tip: 'Connection is secure (https)', icon: 'lock' },
  insecure: { label: 'Not secure', tip: 'Connection is not secure (http): do not enter passwords or card numbers here', icon: 'warning' },
  other: { label: 'Page info', tip: 'This page is not loaded over the web', icon: 'info' },
  /** No page yet (new tab): the field is a search box, like Chrome's NTP omnibox. */
  empty: { label: 'Search', tip: 'Type to search or enter an address', icon: 'search' },
} as const

/** "⋯" menu rows of the browser toolbar. */
export const TOOLBAR_MENU_TEXT = {
  zoomReset: (pct: string) => `Reset zoom (${pct})`,
  device: 'Device mode…',
  shields: 'Shields for this site',
  design: 'Design Mode',
  copyUrl: 'Copy URL',
  openExternal: 'Open in system browser',
  agentOffer: 'Let agents drive…',
  copyFailed: 'Could not copy the address.',
} as const

/** Shields chip (ad/tracker and popup blocking, like Brave Shields). */
export const SHIELDS_TEXT = {
  label: 'Shields',
  on: (ads: number, popups: number, host: string) =>
    `Shields are on for ${host}: ${ads} ${ads === 1 ? 'ad or tracker' : 'ads and trackers'} and ${popups} ${popups === 1 ? 'popup' : 'popups'} blocked on this page. Click to turn Shields off for this site.`,
  off: (host: string) => `Shields are off for ${host}. Click to turn them back on.`,
} as const

// Tawaran inline, HANYA saat user mematikan kendali agent di Pengaturan (default on). Meniru Orca BrowserUsePane "Agent Browser Use":
// "Let coding agents drive this browser with your logins"): konfirmasi dulu karena agent memakai cookie login.
export const AGENT_OFFER_TEXT = {
  offer: 'Let agents drive this browser',
  warning: 'Terminal agents cabled to this browser will be able to click, type, and open pages in it using your login cookies. ' +
    'Page content is untrusted. You can turn this off again in Settings > Capabilities > Browser.',
  confirm: 'Allow',
  cancel: 'Cancel',
  busy: 'Saving…',
  failed: 'Could not allow agent control. Try again.',
} as const

// Tombol pemulihan di bawah pesan overlay node browser (browser.status.ts `noticeAction`).
export const NOTICE_ACTION_TEXT = {
  allow: (hostPort: string) => `Allow ${hostPort}`,
  allowHint: 'Pages in this browser will be able to reach services at that address.',
  allowFailed: 'Could not save the permission. Try again.',
  offer: 'Browser settings',
} as const

export const URL_ERROR_TEXT: Record<UrlRejectReason, string> = {
  invalid: 'That address can’t be opened.',
  scheme: 'Only http and https addresses can be opened.',
  userinfo: 'Addresses with a username or password are not allowed.',
  too_long: 'That address is too long.',
}

export const CHIP_TEXT = {
  driving: 'Agent is driving',
  stop: 'Take control',
  stopLabel: 'Stop the agent and take control of this browser',
} as const

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export const COOKIE_TEXT = {
  title: 'Cookies',
  description: 'Import cookies from a file so this workspace browser stays signed in.',
  warning:
    'Imported cookies can sign this browser in to your accounts, and whatever drives the browser (you or an agent) acts as you. ' +
    'Only import cookies you trust, and only for the sites you pick. Cookies are stored encrypted on this server and expire automatically.',
  fileLabel: 'Cookie file',
  formatLabel: 'File format',
  formats: { storageState: 'Playwright storage state (JSON)', netscape: 'Netscape cookies.txt' },
  preview: 'Preview',
  previewing: 'Reading…',
  domainsHeading: 'Choose sites to import',
  selectAll: 'Select all',
  sessionTag: 'session',
  import: 'Import selected',
  importing: 'Importing…',
  cancel: 'Cancel',
  close: 'Close',
  importedHeading: 'Import complete',
  storedHeading: 'Stored cookies',
  storedEmpty: 'No cookies stored for this workspace yet.',
  removeAll: 'Remove all',
  loading: 'Loading…',
  cookieCount: (n: number) => plural(n, 'cookie', 'cookies'),
  // Kebijakan Orca "Google logins aren't imported": sesi Google terikat perangkat asal.
  googleSkipped: (n: number) => `Google logins aren’t imported — sign in to Google directly in the browser node (${plural(n, 'cookie', 'cookies')} skipped).`,
  imported: (cookies: number, sites: number) => `Imported ${plural(cookies, 'cookie', 'cookies')} from ${plural(sites, 'site', 'sites')}.`,
  removeLabel: (domain: string) => `Remove cookies for ${domain}`,
  selectLabel: (domain: string) => `Import cookies for ${domain}`,
  tooLarge: 'That file is too large.',
  readFail: 'The file could not be read.',
  errors: {
    bad_request: 'The server could not read that file. Check its format and try again.',
    not_found: 'The preview expired. Choose the file again.',
    disabled: 'Cookie import is turned off on this server.',
    payload_too_large: 'That file is too large.',
    generic: 'Something went wrong. Try again.',
  },
  // Panduan ekspor dari browser milik user sendiri (RND/33: webterm tidak membaca store browser lain).
  guide: {
    summary: 'How to get a cookie file',
    optionA: 'Option A: install a cookies.txt (Netscape format) export extension from the Chrome Web Store, open the site, then export only the sites you need. Pick a trusted extension: third-party cookie extensions have been used as malware.',
    optionB: 'Option B: run this in a terminal on your own computer (requires yt-dlp; replace <site-url>). The file contains every browser cookie, so in the next step check only the domains you need.',
    command: 'yt-dlp --cookies-from-browser chrome --cookies cookies.txt --skip-download <site-url>',
    commandLabel: 'yt-dlp cookie export command',
    copy: 'Copy command',
    copied: 'Copied',
    formatHint: 'Then choose the "Netscape cookies.txt" format above and upload the file.',
    warning: 'A cookie file is the same as login access. Import only the domains you need, and delete the file after importing.',
    safest: 'Safest: sign in once directly in this browser node; its profile persists, so no cookie file is needed.',
  },
} as const

// Submenu "Import Cookies" di menu ⋯ node browser (meniru Orca browser-toolbar-menu-dropdown.tsx).
export const COOKIE_MENU_TEXT = {
  importCookies: 'Import Cookies',
  fromFile: 'From File…',
  googleNote: 'Google logins can’t be imported — sign in to Google directly in this browser',
} as const

export const ZOOM_TEXT = {
  out: 'Zoom out',
  in: 'Zoom in',
  level: 'Page zoom level',
  /** Pill in the address field, shown only away from 100%; the accessible name keeps the visible percent. */
  pill: (pct: string) => `Zoom ${pct}, reset to 100%`,
  pillTip: (pct: string) => `Page zoom is ${pct}: click to reset to 100%`,
} as const

export const START_TEXT = {
  page: 'Browser start page',
  searchLabel: 'Search or enter address',
  searchPlaceholder: (engine: string) => `Search ${engine} or enter a URL`,
  shortcuts: 'Shortcuts',
  recent: 'Recent',
  open: (name: string) => `Open ${name}`,
  add: 'Add shortcut',
  tileMenu: (name: string) => `Edit or remove ${name}`,
  edit: 'Edit shortcut',
  remove: 'Remove',
  nameLabel: 'Name',
  urlLabel: 'URL',
  save: 'Done',
  cancel: 'Cancel',
  badUrl: 'Enter a web address (http or https).',
  full: 'Shortcut limit reached: remove one to add another.',
} as const
