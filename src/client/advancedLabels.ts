// Teks bagian "Lanjutan" di tab Kemampuan (Rule 15). Tanpa nama env var dan tanpa istilah teknis internal.
import type { CapabilitiesResponse } from '../shared/featureCapabilities'

type Engine = CapabilitiesResponse['advanced']['agentEngine']['value']

export const ADVANCED_TEXT = {
  summary: 'Lanjutan',
  engineLabel: 'Mesin agen Agent Pusat',
  engineDetected: (name: string): string => `Terdeteksi: ${name}`,
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
  { value: 'mock', label: 'Simulasi' },
]

export const SECTION_TEXT = {
  loading: 'Memuat kemampuan…',
} as const
