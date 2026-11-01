// Test jalur observasi `Sessions` tanpa PTY nyata: `spawn` dan `now` di-inject, jadi open/output/
// exit/close bisa dijalankan deterministik di node-env (vitest). Jalur PTY sungguhan tetap di
// `*.bun.test.ts`; file ini menjaga kontrak subscriber, replay, dan tombstone exit.

import { describe, expect, test } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { Sessions } from './sessions'
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

function harness(now: () => number = () => T0) {
  const ptys: FakePty[] = []
  const sessions = new Sessions({
    spawn: () => {
      const pty = new FakePty(1000 + ptys.length)
      ptys.push(pty)
      return pty
    },
    now,
  })
  return { sessions, ptys }
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

  test('an existing subscriber re-opening gets no replay duplicate', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    sessions.open(open('n1'), a.send)
    ptys[0].emitData('x')

    const outputsBefore = a.outputs().length
    const statusesBefore = a.statuses().length
    sessions.open(open('n1'), a.send)

    expect(a.outputs().length).toBe(outputsBefore)
    expect(a.statuses().length).toBe(statusesBefore + 1)
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

  test('re-opening with the same fn twice replays only once', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    sessions.open(open('n1'), a.send)
    ptys[0].emitData('x')
    sessions.open(open('n1'), a.send)
    sessions.open(open('n1'), a.send)

    expect(a.outputs()).toHaveLength(1)
    expect(a.text()).toBe('x')
  })

  test('P0: opening the same subscriber again after many chunks never duplicates scrollback', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    sessions.open(open('n1'), a.send)
    for (const chunk of ['a', 'b', 'c']) ptys[0].emitData(chunk)
    expect(a.outputs().map((m) => m.seq)).toEqual([1, 2, 3])

    sessions.open(open('n1'), a.send) // mount berulang pada socket yang sama
    sessions.open(open('n1'), a.send)
    expect(a.outputs().map((m) => m.seq)).toEqual([1, 2, 3])
    expect(a.text()).toBe('abc')
    // Hanya snapshot status yang ditambahkan, sekali per open.
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

  test('a later close does not overwrite self or emit a second exit', () => {
    const { sessions, ptys } = harness()
    const a = recorder()
    sessions.open(open('n1'), a.send)
    ptys[0].emitExit(0)

    sessions.close('n1', a.send)
    expect(a.exits()).toHaveLength(1)
    expect(sessions.getExit('n1')).toEqual({ code: 0, reason: 'self', at: T0 })
  })

  test('P0: close after self exit keeps reason self for callers and peers, with no second exit', () => {
    const { sessions, ptys } = harness()
    const peer = recorder()
    sessions.open(open('n1'), peer.send)
    ptys[0].emitExit(7)
    expect(peer.exits()).toEqual([{ t: 'exit', id: 'n1', code: 7, reason: 'self' }])

    // Pemanggil close yang BUKAN pelanggan (socket lain / restart) tetap harus mendengar pencabutan
    // status, tetapi tidak boleh menerima `exit` kedua maupun menimpa tombstone `self`.
    const caller = recorder()
    sessions.close('n1', caller.send)

    expect(caller.statuses()).toEqual([{ t: 'status', id: 'n1' }])
    expect(caller.exits()).toEqual([])
    expect(peer.exits()).toHaveLength(1)
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
