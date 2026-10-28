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
// Perilaku LAMA sesudah `close` pada PTY yang masih hidup: `exit` dipancarkan DI ATAS gerbangnya,
// jadi tepat satu `exit` tetap lolos dan — karena client mencocokkannya by id — mendarat di
// pelanggan berikutnya dengan node id yang sama.
const OLD_EXITS_AFTER_CLOSE_KILL = 1

/** Perekam status; status absen dipetakan ke 'NONE' karena `[undefined].join(',')` sama dengan
 *  senyap — tanpa penandaan ini SENYAP dan PENCABUTAN EKSPLISIT tak terbedakan. `exits` terpisah
 *  dari `seen`: dua jenis pesan yang berbeda, dan test lain di file ini hanya membaca status. */
function recorder() {
  const seen: string[] = []
  const exits: number[] = []
  const send = (m: ServerMsg) => {
    if (m.t === 'status') seen.push(m.status ?? 'NONE')
    else if (m.t === 'exit') exits.push(m.code)
  }
  return { seen, exits, send }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** Tunggu `pid` mati dengan polling pendek berbatas, bukan satu `sleep` panjang (pola
 *  `pty.bun.test.ts`): SIGTERM langsung memakan `sleep`, jadi test selesai dalam milidetik. */
async function waitGone(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(25)
  }
  return !alive(pid)
}

/** Pid PTY sesi `id`. Lewat `map` privat dengan sengaja: ia tidak punya pembaca publik, dan tanpa
 *  pid-nya test di bawah tidak bisa membuktikan `onExit` sudah SEMPAT mendarat — ia akan lulus
 *  hanya karena belum terjadi apa pun. */
function ptyPid(s: Sessions, id: string): number {
  const map = (s as unknown as { map: Map<string, { pty: { pid: number } }> }).map
  const pid = map.get(id)?.pty.pid
  if (!pid) throw new Error(`no live pty for ${id}`)
  return pid
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

test('a pty killed by close does not emit a stale exit to the next session', async () => {
  const s = new Sessions()
  const r = recorder()
  s.open({ t: 'open', id: 'cl5', cols: 80, rows: 24, cmd: 'sleep 20', agentId: 'claude' }, r.send)
  const old = ptyPid(s, 'cl5')

  // Bentuk "New session" (`AgentNode.newSession`): `close` lalu remount SEKETIKA dengan node id yang
  // SAMA lewat socket yang sama — satu `send` untuk keduanya, karena client mendemux `exit` by id.
  s.close('cl5', r.send)
  s.open({ t: 'open', id: 'cl5', cols: 80, rows: 24, cmd: 'sleep 20', agentId: 'claude' }, r.send)

  // `onExit` memancar dari `proc.exited`, jadi prosesnya harus benar-benar hilang dulu; tanpa ini
  // test lulus hanya karena belum sempat terjadi apa pun.
  expect(await waitGone(old, 3000)).toBe(true)
  await sleep(100)

  // Satu-satunya konsumen `exit` adalah `\r\n[process exited]` di `TerminalCore`, jadi yang lolos
  // di sini menulis baris itu ke terminal SEGAR yang baru saja mount.
  expect(r.exits.length).toBe(0)
  expect(r.exits.length).not.toBe(OLD_EXITS_AFTER_CLOSE_KILL)
  s.close('cl5', r.send)
})

test('a pty that exits on its own still emits its exit', async () => {
  const s = new Sessions()
  const r = recorder()
  // Arah sebaliknya: shell biasa yang diketik `exit`. Gerbangnya tidak boleh ikut menelan ini —
  // baris `[process exited]`-nya SAH, dan menghapus pancarannya sama sekali akan lolos test di atas.
  s.open({ t: 'open', id: 'cl6', cols: 80, rows: 24, cmd: 'exit 0' }, r.send)
  const deadline = Date.now() + 5000
  while (!r.exits.length && Date.now() < deadline) await sleep(25)

  expect(r.exits.length).toBe(1)
  expect(r.exits[0]).toBe(0)
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
