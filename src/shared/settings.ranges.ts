/**
 * Satu-satunya tempat angka rentang settings numerik (Rule 15). UI (min/max/step), `mergeSettings`,
 * `terminalConfig`, `terminalKeys` dan server membaca tabel ini; menyalin angkanya ke tempat lain
 * membuat batas UI, clamp client, dan clamp server saling menyimpang.
 *
 * Kunci = nama kunci `Settings` yang bertipe number. Tes (`settings.ranges.test.ts`) menjaga tiap
 * kunci numerik `DEFAULT_SETTINGS` punya entri di sini.
 */

const KIB = 1024
const MIB = 1024 * KIB

export const SETTING_RANGES = {
  // Di bawah 8 px tak terbaca di xterm; di atas 32 px grid tak lagi layak. Zoom ⌘+/⌘− memakai
  // batas yang sama, jadi field dan zoom tidak bisa berbeda.
  fontSize: { min: 8, max: 32, step: 1 },
  // Bobot font numerik CSS.
  fontWeight: { min: 100, max: 900, step: 100 },
  fontWeightBold: { min: 100, max: 900, step: 100 },
  // Di bawah 1 xterm memotong descender; di atas 2 grid-nya sebagian besar udara.
  terminalLineHeight: { min: 1, max: 2, step: 0.05 },
  // Negatif merapatkan; lewat batas ini karakter box-drawing berhenti bertemu dan output tercabik.
  terminalLetterSpacing: { min: -2, max: 4, step: 0.5 },
  // Batas kontras xterm sendiri: 1 mematikan penyesuaian, 21 memaksa hitam-di-atas-putih.
  terminalMinContrast: { min: 1, max: 21, step: 0.5 },
  // Ring buffer byte PTY, PER SESI. Di bawah 16 KiB satu layar penuh sudah terpotong; di atas
  // 64 MiB dikali banyak sesi mengancam memori server.
  scrollbackBytes: { min: 16 * KIB, max: 64 * MIB, step: 16 * KIB },
  // Baris scrollback xterm. Di bawah batas bawah satu `clear` membuang output yang baru lewat; di
  // atas batas atas xterm mengalokasikan `cols × 12 B` per baris per node, dan satu canvas memuat
  // banyak node.
  scrollbackLines: { min: 1_000, max: 100_000, step: 1_000 },
  gridSize: { min: 4, max: 200, step: 1 },
  // Min = ukuran minimum `NodeResizer` semua jenis node.
  defaultNodeWidth: { min: 240, max: 2400, step: 20 },
  defaultNodeHeight: { min: 160, max: 2400, step: 20 },
} as const satisfies Record<string, { min: number; max: number; step?: number }>

export type RangedKey = keyof typeof SETTING_RANGES

/**
 * Paksa `value` ke rentang `key`; bukan angka hingga (NaN, '', null, string) -> `fallback`.
 * Clamp, bukan tolak: klien lama / file edit-tangan mengirim nilai antara dan tak boleh ditolak.
 */
export function clampSetting(key: RangedKey, value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const { min, max } = SETTING_RANGES[key]
  return Math.min(Math.max(min, value), max)
}
