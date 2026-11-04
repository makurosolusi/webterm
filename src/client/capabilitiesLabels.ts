// Semua teks UI kemampuan (Indonesia, Rule 15). Tanpa nama env var dan tanpa istilah teknis internal.
import type { CapabilityId, CapabilityStatus } from '../shared/featureCapabilities'

export const CAPABILITY_STATUS_LABEL: Readonly<Record<CapabilityStatus, string>> = {
  on: 'Aktif',
  off: 'Mati',
  'needs-step': 'Perlu satu langkah',
}

/**
 * Penolakan 403 penjaga pengaturan: sebab (dibuka lewat tunnel/proxy/alamat lain) + jalan keluar.
 * Port dari `location` halaman ini; tanpa port (mis. tunnel di 443) kalimatnya tetap benar tanpa angka.
 */
export function forbiddenText(port: string): string {
  const where = port ? `http://127.0.0.1:${port}` : 'alamat 127.0.0.1 di komputer yang menjalankan webterm'
  return `Perubahan ditolak karena halaman ini tidak dibuka langsung dari komputer yang menjalankan webterm. Buka lewat ${where}, atau aktifkan token akses lalu masuk dengan token itu.`
}

export const CAPABILITY_TEXT = {
  alsoTurnsOn: 'Ikut menyalakan:',
  alsoTurnsOff: 'Ikut mati:',
  offerQuestion: 'Nyalakan sekarang?',
  offerAction: 'Nyalakan',
  offerTitle: (title: string): string => `Nyalakan ${title}`,
  confirmDangerous: (label: string): string =>
    `${label}?\n\nIni memberi agent kendali lebih besar atas komputer ini dan akun yang sedang Anda pakai. Nyalakan hanya bila Anda memercayai agent yang berjalan.`,
  loadFailed: 'Kemampuan belum bisa dimuat. Coba lagi sebentar.',
  changeFailed: 'Perubahan belum berhasil. Coba lagi sebentar.',
  forbidden: forbiddenText(typeof location === 'undefined' ? '' : location.port),
} as const

/**
 * Kata kunci pencarian Settings per kartu (pola indeks pencarian Orca: title + description + keywords).
 * Kata yang diketik orang, bukan judul: "chrome", "cookie", "token", "localhost".
 */
export const CAPABILITY_KEYWORDS: Readonly<Record<CapabilityId | 'advanced' | 'token', readonly string[]>> = {
  central: ['agent', 'asisten', 'pusat', 'central', 'chat', 'ai'],
  workers: ['worker', 'orchestrator', 'perintah', 'jalankan', 'persetujuan', 'approval'],
  autonomy: ['otonomi', 'autonomy', 'otomatis', 'mandiri'],
  browser: ['browser', 'chrome', 'chromium', 'web', 'halaman', 'cookie', 'localhost', 'url', 'link'],
  files: ['file', 'berkas', 'folder', 'explorer'],
  filesWrite: ['file', 'berkas', 'unggah', 'upload', 'edit', 'hapus', 'rename'],
  telegram: ['telegram', 'bot', 'token', 'chat', 'pesan'],
  token: ['token', 'akses', 'keamanan', 'tunnel', 'sandi', 'login', 'perangkat lain', 'remote'],
  advanced: ['lanjutan', 'chrome', 'chromium', 'lokasi', 'mesin', 'engine', 'claude', 'opencode', 'data', 'reset', 'setel ulang'],
}

/** Daftar judul dipisah koma untuk baris "Ikut menyalakan/mati". */
export const joinTitles = (titles: readonly string[]): string => titles.join(', ')
