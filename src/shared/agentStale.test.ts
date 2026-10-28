import { describe, expect, it } from 'vitest'

import { STALE_SWEEP_MS, WORKING_STALE_MS, isStaleWorking } from './agentStale'

// Gejala: node agent yang jelas idle (agent duduk di input box-nya) tetap menandai RUNNING. Ia
// PERNAH running, lalu berhenti tanpa mengirim event penutup — Esc di tengah tool call, CLI dibunuh,
// mesin di-sleep — dan badge-nya tidak pernah turun.
//
// Akar: status hanya bisa turun kalau ada hook yang menyuruhnya turun, jadi tulisan TERAKHIR
// bertahan selamanya. Perilaku LAMA dibawa sebagai konstanta supaya guard di bawah terbukti
// menggigit: dulu TIDAK ADA jam sama sekali, jadi jawaban untuk setiap umur adalah "tidak basi".
const OLD_NO_CLOCK_VERDICT = false

describe('isStaleWorking', () => {
  const t0 = 1_700_000_000_000

  it('menyapu working yang diam melewati jendela', () => {
    expect(isStaleWorking('working', t0, t0 + WORKING_STALE_MS + 1)).toBe(true)
    // Bukti guard menggigit: inilah jawaban yang diberikan webterm sebelum ada jam.
    expect(isStaleWorking('working', t0, t0 + WORKING_STALE_MS + 1)).not.toBe(OLD_NO_CLOCK_VERDICT)
    // Dan ia tetap benar sejauh apa pun di masa depan (mesin yang di-sleep seharian).
    expect(isStaleWorking('working', t0, t0 + 100 * WORKING_STALE_MS)).toBe(true)
  })

  it('TIDAK menyapu working yang masih di dalam jendela', () => {
    expect(isStaleWorking('working', t0, t0)).toBe(false)
    // Persis di batas belum basi — ambangnya `>`, bukan `>=`.
    expect(isStaleWorking('working', t0, t0 + WORKING_STALE_MS)).toBe(false)
    // Jeda hook terpanjang yang nyata: tool Bash claude tertutup di sekitar 10 menit.
    expect(isStaleWorking('working', t0, t0 + 10 * 60_000)).toBe(false)
  })

  it('tidak pernah menyapu state selain working, sejauh apa pun melewati jendela', () => {
    // Aturan nodeterm yang sama (live-work.test.ts:85-89 pada 10 * WORKING_STALE_MS): ketiganya
    // menyatakan sesuatu yang sudah SELESAI terjadi, dan fakta itu tidak kedaluwarsa.
    const far = t0 + 10 * WORKING_STALE_MS
    for (const status of ['waiting', 'blocked', 'done']) {
      expect(isStaleWorking(status, t0, far)).toBe(false)
    }
    // Termasuk node yang memang belum punya status.
    expect(isStaleWorking(undefined, t0, far)).toBe(false)
  })

  it('jendelanya cukup panjang untuk turn yang sah, dan disapu cukup sering', () => {
    // Dua angka ini kontrak yang terlihat pengguna (berapa lama badge salah bisa bertahan), jadi
    // dipatok eksplisit — bukan dibiarkan bergeser diam-diam saat seseorang mengutak-atik modulnya.
    expect(WORKING_STALE_MS).toBe(20 * 60_000)
    expect(STALE_SWEEP_MS).toBe(60_000)
    // Sapuannya harus jauh lebih rapat dari jendelanya, kalau tidak lag deteksinya setara jendela.
    expect(STALE_SWEEP_MS).toBeLessThan(WORKING_STALE_MS)
  })
})
