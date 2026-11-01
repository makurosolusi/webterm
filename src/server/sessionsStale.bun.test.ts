// Bun-only: `open` butuh PTY nyata (Bun.Terminal via spawnPty) supaya ada socket yang menerima
// pesan status. Aturan basi-nya sendiri murni dan diuji tanpa timer di `src/shared/agentStale.test.ts`.
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.WEBTERM_DATA_DIR = mkdtempSync(join(tmpdir(), 'webterm-stale-'))

import type { AgentStatus } from '../shared/workspace'
import type { ServerMsg } from '../shared/protocol'
import { WORKING_STALE_MS } from '../shared/agentStale'
import { Sessions } from './sessions'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Perilaku LAMA sebagai konstanta, supaya guard di bawah terbukti menggigit: tanpa jam, status
// terakhir bertahan selamanya — sebuah node yang pernah 'working' tetap 'working' selamanya.
const OLD_STATUS_AFTER_SILENCE: AgentStatus = 'working'

// Perilaku LAMA pada RE-ATTACH: SENYAP. Server memutar status hanya `if (st)`, jadi node yang
// statusnya sudah dicabut tidak menghasilkan pesan apa pun — dan client, yang menyimpan salinannya
// di map modul, membaca senyap itu sebagai "tidak ada perubahan", bukan "tidak ada status".
const OLD_REATTACH_AFTER_SWEEP = ''

/** Sesi hidup + perekam status. `sleep` supaya PTY tidak keluar dan memancarkan 'done' sendiri. */
function live(id: string) {
  const s = new Sessions()
  const seen: string[] = []
  const record = (m: ServerMsg) => { if (m.t === 'status') seen.push(m.status ?? 'NONE') }
  s.open({ t: 'open', id, cols: 80, rows: 24, cmd: 'sleep 20', agentId: 'claude' }, record)
  // Status yang diputar ulang ke socket yang re-attach = apa yang server masih SIMPAN tentang node.
  // `open` pada id hidup MENAMBAH pelanggan dan memutar status ke pendatang baru saja, jadi probe
  // harus dilepas lagi: `detach` membuang pelanggan ITU saja, dan tanpa itu setiap probe menumpuk
  // jadi pelanggan permanen (set pelanggan tidak lagi mengevict otomatis).
  const stored = (): string => {
    const replay: string[] = []
    const probe = (m: ServerMsg) => { if (m.t === 'status') replay.push(m.status ?? 'NONE') }
    s.open({ t: 'open', id, cols: 80, rows: 24 }, probe)
    s.detach(probe)
    return replay.join(',')
  }
  // Socket-nya pergi tanpa sesinya mati — wifi HP mati, laptop sleep, tab tertidur. `detach`
  // mencocokkan pelanggan lewat identitas fungsi, jadi yang dilepas harus `record` yang sama.
  const drop = () => s.detach(record)
  return { s, seen, stored, drop }
}

const t0 = 1_700_000_000_000

test('a working node that goes silent past the window loses its status', () => {
  const { s, seen, stored } = live('sw1')
  // Pelanggan KEDUA lewat API publik `subscribe`: pencabutan adalah siaran, bukan surat pribadi
  // ke satu socket. Kalau hanya pelanggan pertama yang mendengar, tab lain menyimpan 'working'.
  const other: string[] = []
  s.subscribe('sw1', (m) => { if (m.t === 'status') other.push(m.status ?? 'NONE') })
  s.setStatus('sw1', 'working', t0)
  expect(stored()).toBe('working')
  expect(seen).toContain('working')
  expect(other).toContain('working')

  // Masih di dalam jendela: tidak disentuh. Jeda hook terpanjang yang nyata ~10 menit.
  s.sweepStale(t0 + 10 * 60_000)
  expect(stored()).toBe('working')

  // Melewati jendela: statusnya dicabut, dan client diberi tahu lewat pesan tanpa `status`.
  // Dipotong dari panjang SEBELUM sapuan: pesan `NONE` dari spawn duduk di daftar sejak awal, jadi
  // `toContain('NONE')` di seluruh array akan hijau tanpa sapuan apa pun.
  const seenBefore = seen.length
  const otherBefore = other.length
  s.sweepStale(t0 + WORKING_STALE_MS + 1)
  expect(seen.slice(seenBefore)).toContain('NONE')
  expect(other.slice(otherBefore)).toContain('NONE')

  // Berakhir TANPA status — bukan 'done'. 'done' menggerbangi tombol Resume/Restart (canResumeNode),
  // jadi mengklaimnya berarti membuka tombol di atas tebakan. Socket yang re-attach menerima
  // pernyataan itu secara eksplisit ('NONE' = pesan status tanpa field `status`), bukan senyap.
  expect(stored()).toBe('NONE')
  expect(seen).not.toContain('done')
  // Bukti guard menggigit: inilah yang masih tersimpan sebelum ada jam.
  expect(stored()).not.toBe(OLD_STATUS_AFTER_SILENCE)
  s.close('sw1')
})

test('every status write pushes the clock back, so a long turn is never swept', () => {
  const { s, stored } = live('sw2')
  // Turn panjang yang sah: tool call demi tool call, masing-masing menulis ulang 'working'.
  for (let i = 0; i <= 10; i++) s.setStatus('sw2', 'working', t0 + i * 5 * 60_000)
  // Totalnya 50 menit sejak tulisan PERTAMA — jauh melewati jendela — tapi tulisan TERAKHIR masih
  // segar, jadi node ini tidak tersapu.
  s.sweepStale(t0 + 50 * 60_000 + 1)
  expect(stored()).toBe('working')
  s.close('sw2')
})

test('only working is swept — waiting, blocked and done count forever', () => {
  for (const status of ['waiting', 'blocked', 'done'] as AgentStatus[]) {
    const { s, stored } = live(`sw3-${status}`)
    s.setStatus(`sw3-${status}`, status, t0)
    // Sepuluh kali jendela. Ketiganya menyatakan sesuatu yang sudah SELESAI terjadi, dan fakta itu
    // tidak kedaluwarsa: node yang menunggu jawabanmu semalaman tetap menunggu jawabanmu.
    s.sweepStale(t0 + 10 * WORKING_STALE_MS)
    expect(stored()).toBe(status)
    s.close(`sw3-${status}`)
  }
})

test('the sweep actually runs on its own clock, and can be stopped', async () => {
  const { s, stored } = live('sw4')
  // Interval sengaja dipercepat; jendela basinya tetap yang asli, jadi yang diuji di sini hanya
  // bahwa timer-nya benar-benar tersambung ke `sweepStale` (bagian non-murni satu-satunya).
  const stop = s.startStaleSweep(5)
  s.setStatus('sw4', 'working', t0)
  await sleep(40)
  expect(stored()).toBe('NONE')

  // Dan penghentinya nyata: sesudah stop, tidak ada lagi yang menyapu.
  stop()
  s.setStatus('sw4', 'working', t0)
  await sleep(40)
  expect(stored()).toBe('working')
  s.close('sw4')
})

test('a node swept while its socket was gone hears the withdrawal on re-attach', () => {
  const { s, seen, stored, drop } = live('sw5')
  s.setStatus('sw5', 'working', t0)
  expect(stored()).toBe('working')

  // Urutan nyatanya: socket pergi, lalu sapuan jalan — sapuan tidak peduli ada socket atau tidak.
  drop()
  const emitted = seen.length
  s.sweepStale(t0 + WORKING_STALE_MS + 1)
  // Pencabutannya memang HILANG di kawat: saat dipancarkan tidak ada tujuan pengiriman. Itulah yang
  // membuat re-attach satu-satunya kesempatan mengabarkannya.
  expect(seen.length).toBe(emitted)

  // Dan di re-attach ia sampai, sebagai pernyataan eksplisit.
  expect(stored()).toBe('NONE')
  // Bukti guard menggigit: dulu re-attach senyap di sini, dan browser menyimpan 'working' selamanya.
  expect(stored()).not.toBe(OLD_REATTACH_AFTER_SWEEP)
  expect(stored()).not.toBe(OLD_STATUS_AFTER_SILENCE)
  // Tanpa mengarang nilai nyata apa pun — khususnya bukan 'done', yang membuka Resume/Restart.
  expect(seen).not.toContain('done')
  s.close('sw5')
})
