// Teks bagian "Lanjutan" di tab Kemampuan (Rule 15). Tanpa nama env var dan tanpa istilah teknis internal.
import type { CapabilitiesResponse } from '../shared/featureCapabilities'

type Engine = CapabilitiesResponse['advanced']['agentEngine']['value']

export const ADVANCED_TEXT = {
  summary: 'Lanjutan',
  engineLabel: 'Mesin agen Agent Pusat',
  engineDetected: (name: string): string => `Terdeteksi: ${name}`,
  engineMissing: 'Belum terpasang: pasang Claude Code atau OpenCode, lalu periksa lagi.',
  engineNotLoggedIn: (name: string): string => `${name} terpasang, tapi belum login. Login di terminal, lalu periksa lagi.`,
  engineChosenNotReady: (name: string): string => `${name} belum siap: belum terpasang atau belum login.`,
  engineRecheck: 'Periksa lagi',
  engineChecking: 'Memeriksa…',
  engineRecheckHint: 'Deteksi ulang mesin agen yang terpasang',
  chromiumLabel: 'Lokasi Chromium',
  chromiumPlaceholder: 'Jalur ke aplikasi Chromium',
  chromiumAuto: (path: string): string => `Otomatis: ${path}`,
  chromiumUsingAuto: 'Dipakai (otomatis):',
  chromiumUsingOverride: 'Dipakai (pilihan Anda):',
  chromiumOverrideInvalid: 'Lokasi pilihan Anda tidak ditemukan, jadi browser belum bisa jalan. Perbaiki atau pakai otomatis.',
  chromiumMissing: 'Chromium belum ditemukan. Isi lokasinya di sini.',
  chromiumCandidates: 'Ditemukan di komputer ini',
  chromiumSave: 'Simpan lokasi',
  chromiumUseAuto: 'Pakai otomatis',
  chromiumRedetect: 'Deteksi ulang',
  dataDirLabel: 'Folder data',
  reset: 'Setel ulang kemampuan',
  resetHint: 'Mengembalikan pilihan kemampuan ke awal. Data Anda tidak dihapus.',
  changeFailed: 'Perubahan belum berhasil. Coba lagi sebentar.',
} as const

export const ENGINE_OPTIONS: ReadonlyArray<{ value: Engine; label: string }> = [
  { value: 'auto', label: 'Otomatis' },
  { value: 'claude', label: 'Claude' },
  { value: 'opencode', label: 'OpenCode' },
]

/** Nama mesin hasil deteksi otomatis; `off` = tidak ada CLI yang ditemukan. */
export const engineName = (kind: string): string =>
  kind === 'off' ? 'tidak ada (pasang Claude Code atau OpenCode)'
    : ENGINE_OPTIONS.find((o) => o.value === kind)?.label ?? kind

export const SECTION_TEXT = {
  loading: 'Memuat kemampuan…',
} as const
