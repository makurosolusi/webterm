// Pengaman ukuran untuk pembacaan file utuh (node files / node editor). Payload dimuat penuh di
// server lalu dikirim ke browser dalam satu tembakan — pembacaan tanpa batas atas file raksasa
// (log besar, video yang tak sengaja dibuka sebagai teks) melonjakkan memori di KEDUA sisi
// sekaligus. Pembacaan di atas cap mengembalikan string sentinel, bukan isi file.
//
// MENGAPA SENTINEL, BUKAN STRING KOSONG — ini bagian yang wajib dipertahankan: sentinel diawali
// byte NUL, yang tidak mungkin ada di payload teks/base64 yang sah, sehingga konsumen bisa
// membedakannya dengan murah dan menampilkan "file too large". Kritis: editor TIDAK BOLEH membuka
// buffer kosong untuk file seperti itu — buffer kosong + ⌘S akan mentruncate file asli pengguna.
// Jadi file kelewat besar harus MENOLAK dibuka, bukan dibuka kosong.
export const FS_READ_MAX_BYTES = 10 * 1024 * 1024
export const FS_READ_BINARY_MAX_BYTES = 24 * 1024 * 1024

/** Jendela awal yang diperiksa untuk deteksi biner (ada byte NUL = biner). */
export const SNIFF_BYTES = 8 * 1024
/**
 * Batas body JSON rute `/api/fs/*` (413 `ETOOLARGE` di atasnya). 2x cap baca: escape JSON
 * (`\n`, `\"`, `\uXXXX`) menggelembungkan teks, dan file yang bisa DIBUKA (<= cap baca) harus
 * tetap bisa DISIMPAN balik; margin tetap 64 KiB untuk field pembungkus.
 */
export const FS_BODY_MAX = FS_READ_MAX_BYTES * 2 + 64 * 1024
/** Default `WEBTERM_FILES_LIST_MAX` / `WEBTERM_FILES_UPLOAD_MAX_MB`. */
export const FILES_LIST_MAX_DEFAULT = 5000
export const FILES_UPLOAD_MAX_MB_DEFAULT = 100

// Prefiks string protokol antar lapisan. Konsumen tidak pernah menyentuh literal ini — pakai
// `tooLargeSentinel` / `tooLargeSize`.
const TOO_LARGE_PREFIX = '\u0000webterm:too-large:'
// legacy: prefiks sebelum rename; hanya dikenali (tab/client lama yang belum reload), tak pernah
// diterbitkan. Boleh dihapus setelah 0.10.0.
const LEGACY_TOO_LARGE_PREFIX = '\u0000nodeterm:too-large:'

export function tooLargeSentinel(sizeBytes: number): string {
  return `${TOO_LARGE_PREFIX}${sizeBytes}`
}

/** Ukuran file dalam byte bila `s` adalah sentinel too-large, selain itu null. */
export function tooLargeSize(s: string): number | null {
  const prefix = [TOO_LARGE_PREFIX, LEGACY_TOO_LARGE_PREFIX].find((p) => s.startsWith(p))
  if (!prefix) return null
  const n = Number(s.slice(prefix.length))
  return Number.isFinite(n) ? n : null
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}
