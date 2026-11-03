// Semua teks UI kemampuan (Indonesia, Rule 15). Tanpa nama env var dan tanpa istilah teknis internal.
import type { CapabilityStatus } from '../shared/featureCapabilities'

export const CAPABILITY_STATUS_LABEL: Readonly<Record<CapabilityStatus, string>> = {
  on: 'Aktif',
  off: 'Mati',
  'needs-step': 'Perlu satu langkah',
}

export const CAPABILITY_TEXT = {
  alsoTurnsOn: 'Ikut menyalakan:',
  alsoTurnsOff: 'Ikut mati:',
  offerQuestion: 'Nyalakan sekarang?',
  offerAction: 'Nyalakan',
  loadFailed: 'Kemampuan belum bisa dimuat. Coba lagi sebentar.',
  changeFailed: 'Perubahan belum berhasil. Coba lagi sebentar.',
  forbidden: 'Perubahan ini hanya bisa dilakukan dari aplikasi ini.',
} as const

/** Daftar judul dipisah koma untuk baris "Ikut menyalakan/mati". */
export const joinTitles = (titles: readonly string[]): string => titles.join(', ')
