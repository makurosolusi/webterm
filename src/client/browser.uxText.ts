// Semua teks UI toolbar/chip/dialog cookie browser di satu tempat (satu sumber untuk komponen + test).
import type { UrlRejectReason } from '../shared/browser.url'

export const TOOLBAR_TEXT = {
  group: 'Browser navigation',
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  stop: 'Stop loading',
  urlLabel: 'Address',
  urlPlaceholder: 'https://example.com',
  go: 'Go',
  agentControl: 'Let agent drive',
  agentControlOff: 'Agent control is disabled on this server.',
} as const

export const URL_ERROR_TEXT: Record<UrlRejectReason, string> = {
  invalid: 'Enter a full address starting with http:// or https://.',
  scheme: 'Only http and https addresses can be opened.',
  userinfo: 'Addresses with a username or password are not allowed.',
  too_long: 'That address is too long.',
}

export const CHIP_TEXT = {
  driving: 'Agent is driving this browser',
  stop: 'Stop',
  stopLabel: 'Stop the agent and take over this browser',
} as const

export const COOKIE_TEXT = {
  title: 'Cookies',
  description: 'Import cookies from a file so this workspace browser stays signed in.',
  warning:
    'Imported cookies can sign this browser in to your accounts, and anything driving the browser (you or an agent) acts as you. ' +
    'Only import cookies you trust and only for the sites you choose. They are stored encrypted on this server and expire automatically.',
  fileLabel: 'Cookie file',
  formatLabel: 'File format',
  formats: { storageState: 'Playwright storage state (JSON)', netscape: 'Netscape cookies.txt' },
  preview: 'Preview',
  previewing: 'Reading…',
  domainsHeading: 'Choose the sites to import',
  selectAll: 'Select all',
  sessionTag: 'session',
  import: 'Import selected',
  importing: 'Importing…',
  cancel: 'Cancel',
  close: 'Close',
  importedHeading: 'Import finished',
  storedHeading: 'Stored cookies',
  storedEmpty: 'No cookies stored for this workspace.',
  removeAll: 'Remove all',
  loading: 'Loading…',
  cookieCount: (n: number) => `${n} cookie${n === 1 ? '' : 's'}`,
  imported: (cookies: number, sites: number) => `Imported ${cookies} cookie${cookies === 1 ? '' : 's'} from ${sites} site${sites === 1 ? '' : 's'}.`,
  removeLabel: (domain: string) => `Remove cookies for ${domain}`,
  selectLabel: (domain: string) => `Import cookies for ${domain}`,
  tooLarge: 'That file is too large.',
  readFail: 'The file could not be read.',
  errors: {
    bad_request: 'The server could not read that file. Check the format and try again.',
    not_found: 'The preview expired. Choose the file again.',
    disabled: 'Cookie import is disabled on this server.',
    payload_too_large: 'That file is too large.',
    generic: 'Something went wrong. Try again.',
  },
  // Panduan ekspor dari browser milik user sendiri (RND/33: webterm tidak membaca store browser lain).
  guide: {
    summary: 'Cara mendapatkan berkas cookie',
    optionA: 'Opsi A: pasang ekstensi ekspor cookies.txt (format Netscape) dari Chrome Web Store, buka situsnya, lalu ekspor hanya situs yang dibutuhkan. Pilih ekstensi yang tepercaya: ekstensi cookie pihak ketiga pernah dipakai sebagai malware.',
    optionB: 'Opsi B: jalankan di terminal komputer kamu sendiri (perlu yt-dlp; ganti <url-situs>). Berkasnya memuat semua cookie browser, jadi di langkah berikut centang hanya domain yang perlu.',
    command: 'yt-dlp --cookies-from-browser chrome --cookies cookies.txt --skip-download <url-situs>',
    commandLabel: 'Perintah ekspor cookie yt-dlp',
    copy: 'Salin perintah',
    copied: 'Tersalin',
    formatHint: 'Lalu pilih format "Netscape cookies.txt" di atas dan unggah berkasnya.',
    warning: 'Berkas cookie sama dengan akses login. Impor hanya domain yang perlu, dan hapus berkasnya setelah diimpor.',
    safest: 'Paling aman: login sekali langsung di browser node ini; profilnya persisten, jadi tidak perlu berkas cookie.',
  },
} as const

// Submenu "Import Cookies" di menu ⋯ node browser (meniru Orca browser-toolbar-menu-dropdown.tsx).
export const COOKIE_MENU_TEXT = {
  importCookies: 'Import Cookies',
  fromFile: 'From File…',
  googleNote: 'Login Google tidak bisa diimpor — masuk ke Google langsung di browser ini',
} as const

export const ZOOM_TEXT = {
  out: 'Perkecil halaman',
  in: 'Perbesar halaman',
  level: 'Tingkat zoom halaman',
} as const

export const START_TEXT = {
  page: 'Halaman awal browser',
  searchLabel: 'Cari atau ketik alamat',
  searchPlaceholder: 'Cari di Google atau ketik URL',
  shortcuts: 'Pintasan',
  recent: 'Terbaru',
  open: (name: string) => `Buka ${name}`,
} as const
