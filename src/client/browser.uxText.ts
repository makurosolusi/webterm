// Semua teks UI toolbar/chip/dialog cookie browser di satu tempat (satu sumber untuk komponen + test).
import type { UrlRejectReason } from '../shared/browser.url'

export const TOOLBAR_TEXT = {
  group: 'Navigasi browser',
  back: 'Mundur',
  forward: 'Maju',
  reload: 'Muat ulang',
  stop: 'Hentikan pemuatan',
  urlLabel: 'Alamat',
  urlPlaceholder: 'Cari atau ketik alamat',
  go: 'Buka',
  agentControl: 'Agent boleh mengemudi',
} as const

// Tawaran inline saat kendali agent mati di server (meniru Orca BrowserUsePane "Agent Browser Use":
// "Let coding agents drive this browser with your logins"): konfirmasi dulu karena agent memakai cookie login.
export const AGENT_OFFER_TEXT = {
  offer: 'Izinkan agent mengendalikan browser ini',
  warning: 'Agent terminal akan bisa mengklik, mengetik, dan membuka halaman di browser ini dengan cookie login kamu. ' +
    'Konten halaman tidak tepercaya. Bisa dimatikan lagi di Pengaturan > Kemampuan > Browser.',
  confirm: 'Izinkan',
  cancel: 'Batal',
  busy: 'Menyimpan…',
  failed: 'Gagal mengizinkan kendali agent. Coba lagi.',
} as const

// Tombol pemulihan di bawah pesan overlay node browser (browser.status.ts `noticeAction`).
export const NOTICE_ACTION_TEXT = {
  allow: (hostPort: string) => `Izinkan ${hostPort}`,
  allowHint: 'Halaman di browser ini akan bisa menjangkau layanan di alamat itu.',
  allowFailed: 'Gagal menyimpan izin. Coba lagi.',
  offer: 'Atur browser',
} as const

export const URL_ERROR_TEXT: Record<UrlRejectReason, string> = {
  invalid: 'Alamat itu tidak bisa dibuka.',
  scheme: 'Hanya alamat http dan https yang bisa dibuka.',
  userinfo: 'Alamat berisi nama pengguna atau kata sandi tidak diizinkan.',
  too_long: 'Alamat itu terlalu panjang.',
}

export const CHIP_TEXT = {
  driving: 'Agent sedang mengendalikan browser ini',
  stop: 'Hentikan',
  stopLabel: 'Hentikan agent dan ambil alih browser ini',
} as const

export const COOKIE_TEXT = {
  title: 'Cookie',
  description: 'Impor cookie dari berkas agar browser workspace ini tetap login.',
  warning:
    'Cookie yang diimpor bisa membuat browser ini login ke akun kamu, dan apa pun yang mengendalikan browser (kamu atau agent) bertindak sebagai kamu. ' +
    'Impor hanya cookie yang kamu percaya dan hanya untuk situs yang kamu pilih. Cookie disimpan terenkripsi di server ini dan kedaluwarsa otomatis.',
  fileLabel: 'Berkas cookie',
  formatLabel: 'Format berkas',
  formats: { storageState: 'Playwright storage state (JSON)', netscape: 'Netscape cookies.txt' },
  preview: 'Pratinjau',
  previewing: 'Membaca…',
  domainsHeading: 'Pilih situs yang diimpor',
  selectAll: 'Pilih semua',
  sessionTag: 'sesi',
  import: 'Impor yang dipilih',
  importing: 'Mengimpor…',
  cancel: 'Batal',
  close: 'Tutup',
  importedHeading: 'Impor selesai',
  storedHeading: 'Cookie tersimpan',
  storedEmpty: 'Belum ada cookie tersimpan untuk workspace ini.',
  removeAll: 'Hapus semua',
  loading: 'Memuat…',
  cookieCount: (n: number) => `${n} cookie`,
  imported: (cookies: number, sites: number) => `${cookies} cookie dari ${sites} situs diimpor.`,
  removeLabel: (domain: string) => `Hapus cookie untuk ${domain}`,
  selectLabel: (domain: string) => `Impor cookie untuk ${domain}`,
  tooLarge: 'Berkas itu terlalu besar.',
  readFail: 'Berkas tidak bisa dibaca.',
  errors: {
    bad_request: 'Server tidak bisa membaca berkas itu. Periksa formatnya lalu coba lagi.',
    not_found: 'Pratinjau kedaluwarsa. Pilih berkasnya lagi.',
    disabled: 'Impor cookie mati di server ini.',
    payload_too_large: 'Berkas itu terlalu besar.',
    generic: 'Terjadi kesalahan. Coba lagi.',
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
  importCookies: 'Impor Cookie',
  fromFile: 'Dari Berkas…',
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
  searchPlaceholder: (engine: string) => `Cari di ${engine} atau ketik URL`,
  shortcuts: 'Pintasan',
  recent: 'Terbaru',
  open: (name: string) => `Buka ${name}`,
} as const
