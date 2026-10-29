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

// Prefiks dipertahankan apa adanya dari nodeterm: ia string protokol antar lapisan, dan CLAUDE.md
// melarang rename permukaan `nodeterm:` tanpa perintah eksplisit. Konsumen tidak pernah menyentuh
// literal ini — pakai `tooLargeSentinel` / `tooLargeSize`.
const TOO_LARGE_PREFIX = '\u0000nodeterm:too-large:'

export function tooLargeSentinel(sizeBytes: number): string {
  return `${TOO_LARGE_PREFIX}${sizeBytes}`
}

/** Ukuran file dalam byte bila `s` adalah sentinel too-large, selain itu null. */
export function tooLargeSize(s: string): number | null {
  if (!s.startsWith(TOO_LARGE_PREFIX)) return null
  const n = Number(s.slice(TOO_LARGE_PREFIX.length))
  return Number.isFinite(n) ? n : null
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}
