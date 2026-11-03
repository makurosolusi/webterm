// Data halaman awal browser: mesin pencari + pintasan. Terpisah dari komponen supaya mengganti
// mesin/daftar situs cukup menyentuh berkas ini (tanpa literal tersebar di UI).

/** Awalan URL pencarian; teks kueri ditambahkan di belakangnya dalam bentuk ter-encode. */
export const SEARCH_URL_PREFIX = 'https://www.google.com/search?q='

export interface Shortcut { id: string; label: string; url: string; initial: string; color: string }

/** Pintasan di grid halaman awal (urutan = urutan tampil). Warna = latar ikon bulat berinisial. */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'google', label: 'Google', url: 'https://www.google.com/', initial: 'G', color: '#4285f4' },
  { id: 'youtube', label: 'YouTube', url: 'https://www.youtube.com/', initial: 'Y', color: '#ff0000' },
  { id: 'github', label: 'GitHub', url: 'https://github.com/', initial: 'G', color: '#24292f' },
  { id: 'gmail', label: 'Gmail', url: 'https://mail.google.com/', initial: 'M', color: '#ea4335' },
  { id: 'x', label: 'X', url: 'https://x.com/', initial: 'X', color: '#000000' },
  { id: 'chatgpt', label: 'ChatGPT', url: 'https://chatgpt.com/', initial: 'C', color: '#10a37f' },
  { id: 'reddit', label: 'Reddit', url: 'https://www.reddit.com/', initial: 'R', color: '#ff4500' },
  { id: 'wikipedia', label: 'Wikipedia', url: 'https://www.wikipedia.org/', initial: 'W', color: '#636466' },
]
