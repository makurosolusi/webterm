// Bun-only: jalur yang diuji di sini BUTUH PTY nyata yang keluar sendiri (`onExit` adalah yang
// menyetel 'done' lalu menghapus sesinya dari `map`), jadi ia tidak bisa hidup di vitest.
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Peluncuran agent claude menulis file settings sungguhan — seluruh file diisolasi ke temp.
process.env.WEBTERM_DATA_DIR = mkdtempSync(join(tmpdir(), 'webterm-close-'))

import type { AgentStatus } from '../shared/workspace'
import type { ServerMsg } from '../shared/protocol'
import { Sessions } from './sessions'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Perilaku LAMA sesudah `close` pada node yang PTY-nya sudah keluar: `status` dan `transcripts`
// berada DI BAWAH gerbang `if (!session) return`, jadi keduanya tidak pernah tersentuh dan sesi
// berikutnya dengan node id yang sama mewarisinya.
const OLD_STATUS_AFTER_CLOSE: AgentStatus = 'done'
const OLD_TRANSCRIPT_AFTER_CLOSE = '/tmp/webterm-close-probe.jsonl'

/** Perekam status; status absen dipetakan ke 'NONE' karena `[undefined].join(',')` sama dengan
 *  senyap — tanpa penandaan ini SENYAP dan PENCABUTAN EKSPLISIT tak terbedakan. */
function recorder() {
  const seen: string[] = []
  const send = (m: ServerMsg) => { if (m.t === 'status') seen.push(m.status ?? 'NONE') }
  return { seen, send }
}

/** Status yang diputar ulang ke socket yang re-attach = apa yang server masih SIMPAN tentang node.
 *  `open` MENGGANTI `send` sesi (bukan menambah pelanggan), jadi perekam aslinya dipasang kembali
 *  sesudahnya — tanpa itu probe pertama membuat perekam itu tuli untuk sisa test. */
function stored(s: Sessions, id: string, reinstall: (m: ServerMsg) => void): string[] {
  const probe = recorder()
  s.open({ t: 'open', id, cols: 80, rows: 24 }, probe.send)
  s.open({ t: 'open', id, cols: 80, rows: 24 }, reinstall)
  return probe.seen
}

test('restarting a finished agent does not inherit its done status', async () => {
  const s = new Sessions()
  const r = recorder()
  // Urutan nyatanya: CLI-nya keluar lebih dulu (restart selalu mematikannya), jadi saat `close`
  // tiba node ini sudah lenyap dari `map` dan gerbangnya yang dulu menolak pembersihan.
  s.open({ t: 'open', id: 'cl1', cols: 80, rows: 24, cmd: 'exit 0', agentId: 'claude' }, r.send)
  const deadline = Date.now() + 5000
  while (!r.seen.includes('done') && Date.now() < deadline) await sleep(25)
  expect(r.seen).toContain('done')

  // Bentuk "Restart agent"/"New session": `close` lalu `open` dengan node id yang SAMA.
  s.close('cl1', r.send)
  s.open({ t: 'open', id: 'cl1', cols: 80, rows: 24, cmd: 'sleep 20', agentId: 'claude' }, r.send)

  // PTY-nya baru lahir dan belum berkata apa pun, jadi yang benar adalah TIDAK ADA status —
  // bukan 'done', yang menggerbangi tombol Resume/Restart (`canResumeNode`).
  expect(stored(s, 'cl1', r.send)).toContain('NONE')
  expect(stored(s, 'cl1', r.send)).not.toContain(OLD_STATUS_AFTER_CLOSE)
  s.close('cl1', r.send)
})

test('the socket that asked for the close hears the withdrawal', () => {
  const s = new Sessions()
  const r = recorder()
  s.open({ t: 'open', id: 'cl2', cols: 80, rows: 24, cmd: 'sleep 20', agentId: 'claude' }, r.send)
  s.setStatus('cl2', 'done')
  expect(r.seen).toContain('done')

  const before = r.seen.length
  s.close('cl2', r.send)
  // Tepat satu pesan, dan isinya pencabutan: client menyimpan salinan statusnya lepas dari apakah
  // terminalnya ter-mount, jadi senyap di sini meninggalkan 'done' di browser selamanya.
  expect(r.seen.length).toBe(before + 1)
  expect(r.seen[before]).toBe('NONE')
  expect(r.seen[before]).not.toBe(OLD_STATUS_AFTER_CLOSE)
})

test('a pty killed by close does not post a done status after the fact', async () => {
  const s = new Sessions()
  const r = recorder()
  // Kali ini CLI-nya masih HIDUP saat close — restart node agent yang belum selesai. `close`
  // membunuh PTY-nya, dan `onExit`-nya mendarat SESUDAH itu: gema dari kematian yang kita minta
  // sendiri, bukan agent yang menyelesaikan sesuatu.
  s.open({ t: 'open', id: 'cl4', cols: 80, rows: 24, cmd: 'sleep 20', agentId: 'claude' }, r.send)
  s.setStatus('cl4', 'working')
  s.close('cl4', r.send)
  await sleep(150)

  s.open({ t: 'open', id: 'cl4', cols: 80, rows: 24, cmd: 'sleep 20', agentId: 'claude' }, r.send)
  expect(stored(s, 'cl4', r.send)).toContain('NONE')
  expect(stored(s, 'cl4', r.send)).not.toContain(OLD_STATUS_AFTER_CLOSE)
  s.close('cl4', r.send)
})

test('close clears the transcript path of a node whose pty is already gone', () => {
  const s = new Sessions()
  // Tanpa `open` sama sekali: inilah node yang tidak ada di `map`, satu-satunya bentuk yang
  // gerbangnya dulu lewatkan — dan path transcript sesi mati itu ikut diwarisi node id berikutnya.
  s.setTranscript('cl3', OLD_TRANSCRIPT_AFTER_CLOSE)
  expect(s.getTranscript('cl3')).toBe(OLD_TRANSCRIPT_AFTER_CLOSE)

  s.close('cl3')
  expect(s.getTranscript('cl3')).toBe(undefined)
  expect(s.getTranscript('cl3')).not.toBe(OLD_TRANSCRIPT_AFTER_CLOSE)
})
