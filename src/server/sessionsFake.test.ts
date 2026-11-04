// Test jalur observasi `Sessions` tanpa PTY nyata: `spawn` dan `now` di-inject, jadi open/output/
// exit/close bisa dijalankan deterministik di node-env (vitest). Jalur PTY sungguhan tetap di
// `*.bun.test.ts`; file ini menjaga kontrak subscriber, replay, dan tombstone exit.

import { describe, expect, test } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { delimiter, dirname } from 'node:path'
import { Sessions, agentPath, type SessionsOptions } from './sessions'
import { cliPath } from './cli/cli.launcher'
import { NODE_HEADERS_ENV, NODE_TOKEN_ENV, nodeToken } from './hooks'
import { claudeHeadersPath } from './hooksPaths'
import { PORT } from './launchLine'
import { EXIT_OUTPUT_LIMIT } from './nodeRegistry'
import { ptyEnv } from './ptyShell'
import { FakePty } from './fakePty.testutil'

const T0 = 1_700_000_000_000

type Output = Extract<ServerMsg, { t: 'output' }>
type Exit = Extract<ServerMsg, { t: 'exit' }>
type Status = Extract<ServerMsg, { t: 'status' }>

/** Perekam pesan per "socket". Predikat tipe membuat assertion tidak perlu cast di tiap test. */
function recorder() {
  const messages: ServerMsg[] = []
  const send = (m: ServerMsg): void => { messages.push(m) }
  const outputs = (): Output[] =>
    messages.filter((m): m is Output => m.t === 'output')
  return {
    send,
    messages,
    outputs,
    text: (): string => outputs().map((m) => m.data).join(''),
    exits: (): Exit[] => messages.filter((m): m is Exit => m.t === 'exit'),
    statuses: (): Status[] => messages.filter((m): m is Status => m.t === 'status'),
  }
}

type SpawnOpts = Parameters<NonNullable<SessionsOptions['spawn']>>[0]

/** Satu peluncuran: opsi mentah dari `Sessions` DAN env efektif yang benar-benar dilihat anak.
 *  Env efektif dirakit persis seperti `spawnPty`: filter `ptyEnv(process.env)` lalu injeksi sesi
 *  menimpanya — jadi test bisa membuktikan token root tidak bocor DAN injeksi tetap menang. */
interface SpawnRecord {
  opts: SpawnOpts
  env: Record<string, string>
}

function harness(now: () => number = () => T0) {
  const ptys: FakePty[] = []
  const spawns: SpawnRecord[] = []
  const sessions = new Sessions({
    spawn: (opts) => {
      spawns.push({ opts, env: { ...ptyEnv(process.env, { interactive: !opts.cmd }), ...(opts.env ?? {}) } })
      const pty = new FakePty(1000 + ptys.length)
      ptys.push(pty)
      return pty
    },
    now,
  })
  return { sessions, ptys, spawns }
}

const open = (id: string) => ({ t: 'open' as const, id, cols: 80, rows: 24 })

describe('output fan-out dan replay', () => {
  test('two opens of the same id both receive later output', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    const b = recorder()
    sessions.open(open('n1'), a.send)
    const pty = ptys[0]
    pty.emitData('one')

    sessions.open(open('n1'), b.send)
    // b me-replay scrollback yang sudah ada; a tidak boleh menerimanya dua kali.
    expect(b.text()).toBe('one')
    expect(a.text()).toBe('one')

    pty.emitData('two')
    expect(a.text()).toBe('onetwo')
    expect(b.text()).toBe('onetwo')
  })

  // Remount pada socket yang SAMA membuat ulang xterm, jadi buffer client kosong: replay wajib
  // dikirim lagi ke `send` itu, tetapi TIDAK di-broadcast ke pelanggan lain.
  test('P0: an existing subscriber re-opening on the same socket gets exactly one replay', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    const peer = recorder()
    sessions.open(open('n1'), a.send)
    sessions.open(open('n1'), peer.send)
    ptys[0].emitData('x')

    a.messages.length = 0
    peer.messages.length = 0
    sessions.open(open('n1'), a.send)

    expect(a.outputs().map((m) => m.seq)).toEqual([1])
    expect(a.text()).toBe('x')
    expect(a.statuses()).toEqual([{ t: 'status', id: 'n1' }])
    // Peer tidak ikut menerima replay: open hanya melayani socket pemanggilnya.
    expect(peer.outputs()).toEqual([])
    expect(peer.statuses()).toEqual([])

    // Tidak ada langganan ganda: output sesudahnya mendarat di a tepat satu kali.
    ptys[0].emitData('y')
    expect(a.outputs().map((m) => m.seq)).toEqual([1, 2])
    expect(a.text()).toBe('xy')
  })

  test('a late joiner gets the full scrollback exactly once', () => {
    const { sessions, ptys } = harness()
    sessions.open(open('n1'), recorder().send)
    ptys[0].emitData('aa')
    ptys[0].emitData('bb')

    const late = recorder()
    sessions.open(open('n1'), late.send)
    expect(late.text()).toBe('aabb')
    expect(late.outputs().length).toBe(2)
    expect(late.outputs().map((m) => m.seq)).toEqual([1, 2])

    ptys[0].emitData('cc')
    expect(late.text()).toBe('aabbcc')
  })

  test('re-opening with the same fn twice replays once per open, with no duplicate subscription', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    sessions.open(open('n1'), a.send)
    ptys[0].emitData('x')
    sessions.open(open('n1'), a.send)
    sessions.open(open('n1'), a.send)

    expect(a.outputs()).toHaveLength(3)
    expect(a.outputs().map((m) => m.seq)).toEqual([1, 1, 1])

    // Satu langganan saja: output baru hanya sekali, bukan tiga kali.
    ptys[0].emitData('y')
    expect(a.outputs()).toHaveLength(4)
    expect(a.outputs().at(-1)).toEqual({ t: 'output', id: 'n1', data: 'y', seq: 2 })
  })

  test('P0: opening the same subscriber again after many chunks replays the whole log once', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    sessions.open(open('n1'), a.send)
    for (const chunk of ['a', 'b', 'c']) ptys[0].emitData(chunk)
    expect(a.outputs().map((m) => m.seq)).toEqual([1, 2, 3])

    sessions.open(open('n1'), a.send) // mount berulang pada socket yang sama
    sessions.open(open('n1'), a.send)
    // Dua mount tambahan = dua replay penuh, urut lama→baru, tanpa seq duplikat DI DALAM satu replay.
    expect(a.outputs().map((m) => m.seq)).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3])
    expect(a.text()).toBe('abcabcabc')
    // Sekali snapshot status per open (open pertama + dua remount).
    expect(a.statuses()).toHaveLength(3)
  })

  test('detach(a) leaves b subscribed', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    const b = recorder()
    sessions.open(open('n1'), a.send)
    sessions.open(open('n1'), b.send)
    ptys[0].emitData('1')
    sessions.detach(a.send)
    ptys[0].emitData('2')

    expect(a.text()).toBe('1')
    expect(b.text()).toBe('12')
  })

  test('P0: an empty output chunk is neither logged nor broadcast', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    sessions.open(open('n1'), a.send)
    ptys[0].emitData('')

    expect(a.outputs()).toEqual([])
    expect(sessions.getTerminal('n1')).toBe('')

    // Seq tidak ikut terpakai oleh chunk kosong: output berikutnya tetap seq 1.
    ptys[0].emitData('a')
    expect(a.outputs()).toEqual([{ t: 'output', id: 'n1', data: 'a', seq: 1 }])
  })

  test('P0: a subscriber that detaches its peer mid-delivery does not starve it', () => {
    const { sessions, ptys } = harness()
    const b = recorder()
    let detached = false
    const a = recorder()
    const aSend = (m: ServerMsg): void => {
      aSend_inner(m)
      // Sekali saja, saat output pertama mendarat: hapus b dari dalam callback a. Status `open`
      // datang lebih dulu, jadi gerbangnya pesan `output`, bukan sembarang pesan.
      if (m.t === 'output' && !detached) { detached = true; sessions.detach(b.send) }
    }
    const aSend_inner = a.send
    sessions.open(open('n1'), aSend)
    sessions.open(open('n1'), b.send)
    ptys[0].emitData('first')

    // Snapshot broadcast: b masih menerima pesan yang sedang dikirim, lalu keluar dari set.
    expect(a.text()).toBe('first')
    expect(b.text()).toBe('first')

    ptys[0].emitData('second')
    expect(a.text()).toBe('firstsecond')
    expect(b.text()).toBe('first')
  })

  test('getTerminal returns the capped log text', () => {
    const { sessions, ptys } = harness()
    sessions.open(open('n1'), recorder().send)
    ptys[0].emitData('hello ')
    ptys[0].emitData('world')
    expect(sessions.getTerminal('n1')).toBe('hello world')
    expect(sessions.getTerminal('missing')).toBe('')
  })
})

describe('close', () => {
  test('emits exactly one exit{closed} per subscriber plus a tombstone; later fake exit ignored', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    const b = recorder()
    sessions.open(open('n1'), a.send)
    sessions.open(open('n1'), b.send)

    sessions.close('n1', a.send)

    // a adalah pelanggan DAN pemanggil: broadcast tidak boleh digandakan. Tiap recorder memegang
    // satu status dari open, jadi close menambah tepat satu lagi (total 2, bukan 3 untuk a).
    for (const r of [a, b]) {
      expect(r.exits()).toEqual([{ t: 'exit', id: 'n1', code: -1, reason: 'closed' }])
      expect(r.statuses()).toHaveLength(2)
      expect(r.statuses().at(-1)).toEqual({ t: 'status', id: 'n1' })
    }
    expect(sessions.getExit('n1')).toEqual({ code: -1, reason: 'closed', at: T0 })
    expect(sessions.isLive('n1')).toBe(false)
    expect(sessions.statusOf('n1')).toBeUndefined()
    expect(ptys[0].killed).toBe(1)

    // Gema kematian dari PTY yang kita bunuh sendiri tidak boleh jadi exit kedua.
    ptys[0].emitExit(0)
    expect(a.exits()).toHaveLength(1)
    expect(b.exits()).toHaveLength(1)
    expect(sessions.getExit('n1')?.reason).toBe('closed')
  })

  test('the calling socket that is not a subscriber still hears the withdrawal', () => {
    const { sessions } = harness()
    sessions.open(open('n1'), recorder().send)
    const caller = recorder()
    sessions.close('n1', caller.send)

    expect(caller.statuses()).toEqual([{ t: 'status', id: 'n1' }])
    expect(caller.exits()).toEqual([{ t: 'exit', id: 'n1', code: -1, reason: 'closed' }])
  })

  test('closing a node with no live session does not resurrect it', () => {
    const { sessions } = harness()
    const caller = recorder()
    sessions.close('ghost', caller.send)
    expect(caller.statuses()).toEqual([{ t: 'status', id: 'ghost' }])
    expect(caller.exits()).toEqual([{ t: 'exit', id: 'ghost', code: -1, reason: 'closed' }])
    expect(sessions.isLive('ghost')).toBe(false)
  })

  // Node ditutup, tapi alasannya (baris terakhir output) harus tetap terbaca: `wait until:exit`
  // dan `observe` membaca lewat `getTerminal` SESUDAH sesi hilang dari `map`.
  test('output captured on close stays readable via getTerminal without resurrecting', () => {
    const { sessions, ptys } = harness()
    sessions.open(open('n1'), recorder().send)
    ptys[0].emitData('first line\n')
    ptys[0].emitData('bye\n')

    sessions.close('n1')

    expect(sessions.isLive('n1')).toBe(false)
    expect(sessions.pidOf('n1')).toBeUndefined()
    expect(sessions.list()).toEqual([])
    expect(sessions.getExit('n1')?.output).toBe('first line\nbye\n')
    expect(sessions.getTerminal('n1')).toBe('first line\nbye\n')
  })
})

describe('self exit', () => {
  test('emits reason self, sets done, and records the exit code', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    sessions.open(open('n1'), a.send)
    ptys[0].emitExit(3)

    expect(a.exits()).toEqual([{ t: 'exit', id: 'n1', code: 3, reason: 'self' }])
    expect(a.statuses()).toContainEqual({ t: 'status', id: 'n1', status: 'done' })
    expect(sessions.getExit('n1')).toEqual({ code: 3, reason: 'self', at: T0 })
    expect(sessions.isLive('n1')).toBe(false)
    expect(sessions.getTerminal('n1')).toBe('')
  })

  test('self exit keeps the final output in the tombstone', () => {
    const { sessions, ptys } = harness()
    sessions.open(open('n1'), recorder().send)
    ptys[0].emitData('building...\n')
    ptys[0].emitData('error: nope\n')

    ptys[0].emitExit(2)

    expect(sessions.isLive('n1')).toBe(false)
    expect(sessions.getExit('n1')).toEqual({
      code: 2,
      reason: 'self',
      at: T0,
      output: 'building...\nerror: nope\n',
    })
    expect(sessions.getTerminal('n1')).toBe('building...\nerror: nope\n')
    // Masih tombstone, bukan sesi hidup: status `done` tidak berubah jadi aktif.
    expect(sessions.statusOf('n1')).toBe('done')
  })

  test('a later close does not overwrite self or emit a second exit', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    sessions.open(open('n1'), a.send)
    ptys[0].emitExit(0)

    sessions.close('n1', a.send)
    expect(a.exits()).toHaveLength(1)
    expect(sessions.getExit('n1')).toEqual({ code: 0, reason: 'self', at: T0 })
  })

  test('P0: a late hook status after self exit cannot resurrect the dead node', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    sessions.open(open('n1'), a.send)
    ptys[0].emitExit(0)
    expect(sessions.statusOf('n1')).toBe('done')
    const statusesAfterExit = a.statuses().length

    // Hook `Stop`/`PreToolUse` claude yang telat mendarat sesudah shell keluar.
    sessions.setStatus('n1', 'working')
    sessions.setStatus('n1', 'waiting')

    expect(sessions.statusOf('n1')).toBe('done')
    expect(a.statuses()).toHaveLength(statusesAfterExit) // tidak ada broadcast status baru
    expect(sessions.getExit('n1')).toEqual({ code: 0, reason: 'self', at: T0 })
  })

  test('P0: a late hook status after close cannot resurrect the closed node', () => {
    const { sessions } = harness()
    sessions.open(open('n1'), recorder().send)
    sessions.close('n1')
    sessions.setStatus('n1', 'working')

    expect(sessions.statusOf('n1')).toBeUndefined()
    expect(sessions.isLive('n1')).toBe(false)
  })

  test('P0: close after self exit keeps reason self for callers and peers, with no second exit', () => {
    const { sessions, ptys } = harness()
    const peer = recorder()
    sessions.open(open('n1'), peer.send)
    ptys[0].emitExit(7)
    expect(peer.exits()).toEqual([{ t: 'exit', id: 'n1', code: 7, reason: 'self' }])
    // `done` sudah tersimpan SEBELUM tombstone; close yang menyusul lalu menghapusnya sendiri.
    expect(sessions.statusOf('n1')).toBe('done')

    // Pemanggil close yang BUKAN pelanggan (socket lain / restart) tetap harus mendengar pencabutan
    // status, tetapi tidak boleh menerima `exit` kedua maupun menimpa tombstone `self`.
    const caller = recorder()
    sessions.close('n1', caller.send)

    expect(caller.statuses()).toEqual([{ t: 'status', id: 'n1' }])
    expect(caller.exits()).toEqual([])
    expect(peer.exits()).toHaveLength(1)
    // close memang menghapus status node (bukan menulis ulang); yang penting tombstone `self` tetap.
    expect(sessions.statusOf('n1')).toBeUndefined()
    expect(sessions.getExit('n1')).toEqual({ code: 7, reason: 'self', at: T0 })
    expect(ptys[0].killed).toBe(0) // PTY sudah mati sendiri; close tidak memanggil kill lagi
  })
})

describe('registry queries dan tombstone', () => {
  test('list/isLive/statusOf/pidOf follow live sessions', () => {
    const { sessions, ptys } = harness()
    sessions.open(open('n1'), recorder().send)
    sessions.open(open('n2'), recorder().send)

    expect(sessions.list().map((s) => s.id)).toEqual(['n1', 'n2'])
    expect(sessions.list().map((s) => s.pid)).toEqual([1000, 1001])
    expect(sessions.pidOf('n2')).toBe(1001)
    expect(sessions.pidOf('missing')).toBeUndefined()
    expect(sessions.isLive('n1')).toBe(true)
    expect(sessions.statusOf('n1')).toBeUndefined()

    sessions.setStatus('n1', 'working')
    expect(sessions.statusOf('n1')).toBe('working')
    expect(sessions.list().find((s) => s.id === 'n1')?.status).toBe('working')

    ptys[0].emitExit(0)
    expect(sessions.isLive('n1')).toBe(false)
    expect(sessions.list().map((s) => s.id)).toEqual(['n2'])
  })

  test('subscribe adds a listener, returns an unsubscribe, and misses dead sessions', () => {
    const { sessions, ptys } = harness()
    sessions.open(open('n1'), recorder().send)
    const sub = recorder()
    const unsubscribe = sessions.subscribe('n1', sub.send)
    expect(unsubscribe).toBeTypeOf('function')

    ptys[0].emitData('hi')
    expect(sub.text()).toBe('hi')
    unsubscribe?.()
    ptys[0].emitData('!')
    expect(sub.text()).toBe('hi')

    expect(sessions.subscribe('missing', sub.send)).toBeUndefined()
  })

  test('a fresh spawn clears the previous tombstone and status', () => {
    const { sessions } = harness()
    sessions.open(open('n1'), recorder().send)
    sessions.setStatus('n1', 'done')
    sessions.close('n1')
    expect(sessions.getExit('n1')?.reason).toBe('closed')

    sessions.open(open('n1'), recorder().send)
    expect(sessions.getExit('n1')).toBeUndefined()
    expect(sessions.statusOf('n1')).toBeUndefined()
    expect(sessions.isLive('n1')).toBe(true)
    // Output lama tidak ikut diwarisi: sesi baru mulai dari layar kosong.
    expect(sessions.getTerminal('n1')).toBe('')
  })

  test('exit tombstones stay bounded', () => {
    const { sessions } = harness()
    const total = 300
    for (let i = 0; i < total; i++) {
      sessions.open(open(`t${i}`), recorder().send)
      sessions.close(`t${i}`)
    }
    expect(sessions.getExit('t0')).toBeUndefined()
    expect(sessions.getExit(`t${total - 1}`)).toEqual({ code: -1, reason: 'closed', at: T0 })
  })

  test('evicting the oldest tombstone also drops its captured output', () => {
    const { sessions, ptys } = harness()
    const total = 300
    for (let i = 0; i < total; i++) {
      sessions.open(open(`t${i}`), recorder().send)
      ptys[i].emitData(`out${i}`)
      sessions.close(`t${i}`)
    }

    // Node tertua sudah di-forget, jadi tidak ada output yatim yang tertinggal di memori.
    expect(sessions.getExit('t0')).toBeUndefined()
    expect(sessions.getTerminal('t0')).toBe('')
    expect(sessions.getTerminal(`t${total - 1}`)).toBe(`out${total - 1}`)
  })

  test('P0: resubscribe after close spawns a fresh session instead of replaying the tombstone', () => {
    const { sessions, ptys } = harness()
    const first = recorder()
    sessions.open(open('n1'), first.send)
    ptys[0].emitData('old')
    ptys[0].emitExit(0)
    expect(sessions.getExit('n1')?.reason).toBe('self')

    const retry = recorder()
    sessions.open(open('n1'), retry.send)

    // Sesi baru, PTY baru: bukan re-attach ke PTY mati dan bukan tombstone lama.
    expect(ptys).toHaveLength(2)
    expect(sessions.isLive('n1')).toBe(true)
    expect(sessions.pidOf('n1')).toBe(1001)
    expect(sessions.getExit('n1')).toBeUndefined()
    expect(sessions.statusOf('n1')).toBeUndefined()
    expect(retry.text()).toBe('') // scrollback lama TIDAK diputar ulang
    expect(retry.outputs()).toEqual([])
    expect(retry.statuses()).toEqual([{ t: 'status', id: 'n1' }])

    ptys[1].emitData('new')
    expect(retry.text()).toBe('new')
    expect(first.text()).toBe('old') // socket lama tidak ikut menerima output sesi baru
  })
})

describe('exit output cap', () => {
  test('keeps only the newest EXIT_OUTPUT_LIMIT bytes of a large exit', () => {
    const { sessions, ptys } = harness()
    sessions.open(open('n1'), recorder().send)
    // 80 KiB > cap 64 KiB, tiap chunk berbeda supaya urutan byte yang tersisa bisa dibuktikan.
    const chunks = Array.from({ length: 80 }, (_, i) =>
      String.fromCharCode(65 + (i % 26)).repeat(1024))
    for (const chunk of chunks) ptys[0].emitData(chunk)
    const full = chunks.join('')

    ptys[0].emitExit(0)

    const kept = sessions.getTerminal('n1')
    expect(kept).toHaveLength(EXIT_OUTPUT_LIMIT)
    expect(kept).toBe(full.slice(full.length - EXIT_OUTPUT_LIMIT))
  })

  test('truncation never splits a multi-byte UTF-8 character', () => {
    const { sessions, ptys } = harness()
    sessions.open(open('n1'), recorder().send)
    // 'é' = 2 byte; 80 KiB total, cap 64 KiB = 32768 karakter utuh.
    ptys[0].emitData('é'.repeat(40 * 1024))

    ptys[0].emitExit(0)

    const kept = sessions.getTerminal('n1')
    expect(kept).toBe('é'.repeat(EXIT_OUTPUT_LIMIT / 2))
    expect(kept.includes('\uFFFD')).toBe(false)
  })
})

describe('P0: id node tidak sah', () => {
  test('open with an unsafe id is ignored: no spawn, no list entry, no status', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    for (const id of ['', 'has space', '-x; rm -rf /', 'a'.repeat(65), 'ünïcode']) {
      sessions.open({ t: 'open', id, cols: 80, rows: 24 }, a.send)
    }

    expect(ptys).toHaveLength(0)
    expect(sessions.list()).toEqual([])
    expect(a.messages).toEqual([])
    for (const id of ['', 'has space', '-x; rm -rf /', 'a'.repeat(65)]) {
      expect(sessions.isLive(id)).toBe(false)
      expect(sessions.getExit(id)).toBeUndefined()
      expect(sessions.statusOf(id)).toBeUndefined()
    }
  })
})

describe('P0: pane split ids', () => {
  test('open accepts `${nodeId}:p${n}` and spawns a PTY', () => {
    const { sessions, ptys } = harness()
    const pane = recorder()
    sessions.open({ t: 'open', id: '3f2a1c00-0000-4000-8000-000000000001:p2', cols: 80, rows: 24 }, pane.send)
    expect(ptys).toHaveLength(1)
    expect(sessions.isLive('3f2a1c00-0000-4000-8000-000000000001:p2')).toBe(true)
    ptys[0].emitData('pane')
    expect(pane.text()).toBe('pane')
  })
})

// Token root (`WEBTERM_TOKEN` proses server) adalah kunci penuh API manusia. Anak PTY tidak boleh
// mewarisinya: agent menerima token NODE-nya sendiri, terminal biasa tidak menerima kunci apa pun.
describe('P0: env anak tidak mewarisi token root', () => {
  const ROOT = 'root-token-must-not-leak'
  const INHERITED = {
    WEBTERM_TOKEN: ROOT,
    WEBTERM_ALLOW_TOKEN_MINT: '1',
    NODETERM_NODE_ID: 'inherited-node',
    NODETERM_PORT: '1234',
  }

  /** Pasang env warisan server, jalankan test, lalu kembalikan persis seperti semula. */
  function withInheritedEnv(fn: () => void): void {
    const saved = new Map<string, string | undefined>()
    for (const k of Object.keys(INHERITED)) {
      saved.set(k, process.env[k])
      process.env[k] = INHERITED[k as keyof typeof INHERITED]
    }
    try {
      fn()
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  test('agent node gets the path of its own header file and its identity, never a token value', () => {
    withInheritedEnv(() => {
      const { sessions, spawns } = harness()
      sessions.open({ ...open('agent-1'), agentId: 'claude' }, recorder().send)

      const env = spawns[0].env
      // Token di env terbaca proses ber-uid sama (KERN_PROCARGS2): yang dibawa hanya PATH file header.
      expect(env[NODE_HEADERS_ENV]).toBe(claudeHeadersPath('agent-1'))
      expect('WEBTERM_TOKEN' in env).toBe(false)
      expect(NODE_TOKEN_ENV in env).toBe(false)
      expect(Object.values(env)).not.toContain(nodeToken('agent-1'))
      expect(Object.values(env)).not.toContain(ROOT)
      expect(env.NODETERM_NODE_ID).toBe('agent-1')
      expect(env.NODETERM_PORT).toBe(String(PORT))
      // `webterm` resolves by name: its bin dir leads PATH, the inherited PATH follows untouched.
      expect(env.PATH.split(delimiter)[0]).toBe(dirname(cliPath()))
      expect(env.PATH).toBe(agentPath(process.env.PATH))
      expect(agentPath(['/a', dirname(cliPath()), '', '/b'].join(delimiter))).toBe([dirname(cliPath()), '/a', '/b'].join(delimiter))
    })
  })

  test('plain terminal gets no WEBTERM token and no NODETERM identity', () => {
    withInheritedEnv(() => {
      const { sessions, spawns } = harness()
      sessions.open(open('shell-1'), recorder().send)

      const { opts, env } = spawns[0]
      expect('WEBTERM_TOKEN' in env).toBe(false)
      expect(Object.keys(env).filter((k) => k.startsWith('NODETERM_'))).toEqual([])
      // Tidak ada injeksi sama sekali untuk terminal biasa (PATH ikut: tanpa bin dir webterm).
      expect(opts.env).toBeUndefined()
      expect(env.PATH?.split(delimiter)[0]).not.toBe(dirname(cliPath()))
    })
  })

  test('inherited WEBTERM_*/NODETERM_* are stripped before injection', () => {
    withInheritedEnv(() => {
      const { sessions, spawns } = harness()
      sessions.open({ ...open('agent-2'), agentId: 'claude' }, recorder().send)
      sessions.open(open('shell-2'), recorder().send)

      for (const { env } of spawns) {
        // Variabel root yang TIDAK di-inject sesi tidak boleh lolos lewat warisan.
        expect('WEBTERM_ALLOW_TOKEN_MINT' in env).toBe(false)
        // Nilai warisan tidak boleh bertahan: yang ada hanya injeksi milik node ini.
        expect(env.WEBTERM_TOKEN).not.toBe(ROOT)
        expect(env.NODETERM_NODE_ID).not.toBe('inherited-node')
        expect(env.NODETERM_PORT).not.toBe('1234')
      }
    })
  })
})
