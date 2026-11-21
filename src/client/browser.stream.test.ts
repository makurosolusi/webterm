import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAudioFrame, encodeFrame } from '../shared/browser.wire'
import { createBrowserStream } from './browser.stream'
import type { BrowserListener } from './browser.stream'
import { setConnection } from './ws.connection'

class FakeWs {
  static all: FakeWs[] = []
  readyState = 0
  binaryType = ''
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() { FakeWs.all.push(this) }
  send(s: string) { this.sent.push(s) }
  close() { this.readyState = 3; this.onclose?.() }
  open() { this.readyState = 1; this.onopen?.() }
  msgs() { return this.sent.map((s) => JSON.parse(s)) }
}
const VP = { w: 800, h: 600, dpr: 1 }
const listener = (): BrowserListener & { frames: Array<[number, number]>; msgs: unknown[]; up: boolean[] } => {
  const l = {
    frames: [] as Array<[number, number]>, msgs: [] as unknown[], up: [] as boolean[],
    onFrame: (seq: number, jpeg: Uint8Array) => { l.frames.push([seq, jpeg.length]) },
    onMsg: (m: unknown) => { l.msgs.push(m) },
    onConnection: (u: boolean) => { l.up.push(u) },
  }
  return l as never
}

beforeEach(() => { FakeWs.all = []; vi.useFakeTimers(); setConnection({ phase: 'connecting', attempt: 0 }) })
afterEach(() => { vi.useRealTimers() })

const make = () => createBrowserStream(() => new FakeWs() as unknown as WebSocket)

describe('browser.stream', () => {
  it('attach carries the profile the node was created on, also when the socket re-attaches after a resize and a reconnect', () => {
    const s = make()
    s.subscribe('a', listener())
    s.attach('a', VP, 'bp-0123456789ab')
    const ws = FakeWs.all[0]
    ws.open()
    expect(ws.msgs()).toEqual([{ t: 'attach', id: 'a', ...VP, profileId: 'bp-0123456789ab' }])
    s.resize('a', { ...VP, w: 900 })
    ws.close()
    vi.advanceTimersByTime(60_000)
    const ws2 = FakeWs.all[1]
    ws2.open()
    expect(ws2.msgs()).toEqual([{ t: 'attach', id: 'a', ...VP, w: 900, profileId: 'bp-0123456789ab' }])
  })

  it('satu socket untuk semua node; attach dikirim setelah open; frame biner dan JSON dirutekan per id', () => {
    const s = make()
    const a = listener(), b = listener()
    s.subscribe('a', a); s.subscribe('b', b)
    s.attach('a', VP); s.attach('b', VP)
    expect(FakeWs.all).toHaveLength(1)
    const ws = FakeWs.all[0]
    expect(ws.binaryType).toBe('arraybuffer')
    expect(ws.sent).toEqual([]) // belum open
    ws.open()
    expect(ws.msgs()).toEqual([{ t: 'attach', id: 'a', ...VP }, { t: 'attach', id: 'b', ...VP }])

    const f = encodeFrame('b', 7, new Uint8Array([1, 2, 3]))
    ws.onmessage?.({ data: f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) })
    expect(b.frames).toEqual([[7, 3]])
    expect(a.frames).toEqual([])

    ws.onmessage?.({ data: JSON.stringify({ t: 'cursor', id: 'a', css: 'pointer' }) })
    expect(a.msgs).toEqual([{ t: 'cursor', id: 'a', css: 'pointer' }])
  })

  it('pesan rusak / tanpa id dibuang tanpa melempar', () => {
    const s = make()
    const a = listener()
    s.subscribe('a', a); s.attach('a', VP)
    const ws = FakeWs.all[0]; ws.open()
    expect(() => {
      ws.onmessage?.({ data: '{nope' })
      ws.onmessage?.({ data: JSON.stringify({ t: 'state' }) })
      ws.onmessage?.({ data: new ArrayBuffer(1) })
    }).not.toThrow()
    expect(a.msgs).toEqual([])
  })

  it('resize memperbarui vp yang diputar ulang; detach dan unsubscribe mengirim detach sekali', () => {
    const s = make()
    const a = listener()
    const unsub = s.subscribe('a', a)
    s.attach('a', VP)
    const ws = FakeWs.all[0]; ws.open()
    s.resize('a', { w: 400, h: 300, dpr: 2 })
    s.send({ t: 'ack', id: 'a', seq: 1 })
    unsub()
    unsub()
    expect(ws.msgs().map((m) => m.t)).toEqual(['attach', 'resize', 'ack', 'detach'])
    s.resize('a', VP) // tidak attached: diabaikan
    expect(ws.sent).toHaveLength(4)
  })

  it('input saat socket belum/tidak open dibuang; putus -> reconnect 1 dtk dan attach diputar ulang', () => {
    const s = make()
    const a = listener()
    s.subscribe('a', a)
    s.attach('a', VP)
    const ws1 = FakeWs.all[0]
    s.send({ t: 'copy', id: 'a' })
    expect(ws1.sent).toEqual([])
    ws1.open()
    s.resize('a', { w: 10, h: 20, dpr: 1 })
    ws1.close()
    expect(a.up).toEqual([true, false])
    s.send({ t: 'copy', id: 'a' }) // mati: dibuang
    expect(ws1.sent).toHaveLength(2)
    vi.advanceTimersByTime(1000)
    expect(FakeWs.all).toHaveLength(2)
    FakeWs.all[1].open()
    expect(FakeWs.all[1].msgs()).toEqual([{ t: 'attach', id: 'a', w: 10, h: 20, dpr: 1 }])
  })

  it('tanpa attach aktif tidak reconnect', () => {
    const s = make()
    s.subscribe('a', listener())
    s.attach('a', VP)
    const ws = FakeWs.all[0]; ws.open()
    s.detach('a')
    ws.close()
    vi.advanceTimersByTime(5000)
    expect(FakeWs.all).toHaveLength(1)
  })

  it('reconnect mundur (backoff jitter, plafon), jeda selama offline/auth, langsung sambung saat connected', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999) // delay = plafon tiap percobaan
    try {
      const s = make()
      const a = listener()
      s.subscribe('a', a); s.attach('a', VP)
      FakeWs.all[0].close() // gagal sebelum open
      vi.advanceTimersByTime(998)
      expect(FakeWs.all).toHaveLength(1)
      vi.advanceTimersByTime(2)
      expect(FakeWs.all).toHaveLength(2) // percobaan 0: ~1 dtk
      FakeWs.all[1].close()
      vi.advanceTimersByTime(1500)
      expect(FakeWs.all).toHaveLength(2) // percobaan 1: ~2 dtk, bukan 1 dtk lagi
      vi.advanceTimersByTime(500)
      expect(FakeWs.all).toHaveLength(3)

      setConnection({ phase: 'offline', attempt: 3 })
      FakeWs.all[2].close()
      vi.advanceTimersByTime(60_000)
      expect(FakeWs.all).toHaveLength(3) // offline: tidak ada percobaan
      s.send({ t: 'copy', id: 'a' }) // input saat mati tetap dibuang
      expect(a.up.at(-1)).toBe(false) // dan node tahu ia terputus

      setConnection({ phase: 'connected', attempt: 0 })
      expect(FakeWs.all).toHaveLength(4) // server kembali: sambung seketika
      FakeWs.all[3].open()
      expect(FakeWs.all[3].msgs()).toEqual([{ t: 'attach', id: 'a', ...VP }])
      s.reset()
    } finally {
      vi.restoreAllMocks()
    }
  })

  describe('audio', () => {
    const opened = () => {
      const s = make()
      const l = listener() as ReturnType<typeof listener> & { chunks: unknown[] }
      l.chunks = []
      l.onAudio = (c) => { l.chunks.push(c) }
      s.subscribe('a', l)
      s.attach('a', VP)
      const ws = FakeWs.all[0]
      ws.open()
      return { s, l, ws }
    }

    it('audio on goes after attach; off stops; frames type 3 reach onAudio, not onFrame', () => {
      const { s, l, ws } = opened()
      s.setAudio('a', true)
      expect(ws.msgs().map((m) => m.t)).toEqual(['attach', 'audio'])
      expect(ws.msgs()[1]).toEqual({ t: 'audio', id: 'a', on: true })
      const frame = encodeAudioFrame({ nodeId: 'a', streamKey: 'k1', seq: 0, t: 5, payload: new Uint8Array([1, 2]) })
      ws.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) })
      expect(l.chunks).toHaveLength(1)
      expect(l.frames).toHaveLength(0)
      s.setAudio('a', false)
      expect(ws.msgs().at(-1)).toEqual({ t: 'audio', id: 'a', on: false })
    })

    it('reconnect restores the listening intent after the re-attach, not before; off is not restored', () => {
      const { s, ws } = opened()
      s.setAudio('a', true)
      ws.close()
      vi.advanceTimersByTime(60_000)
      const ws2 = FakeWs.all[1]
      ws2.open()
      expect(ws2.msgs().map((m) => m.t)).toEqual(['attach', 'audio'])
      s.setAudio('a', false)
      ws2.close()
      vi.advanceTimersByTime(60_000)
      const ws3 = FakeWs.all[2]
      ws3.open()
      expect(ws3.msgs().map((m) => m.t)).toEqual(['attach'])
    })

    it('intent set before the socket is open is sent after attach', () => {
      const s = make()
      s.subscribe('a', listener())
      s.setAudio('a', true)
      s.attach('a', VP)
      const ws = FakeWs.all[0]
      ws.open()
      expect(ws.msgs().map((m) => m.t)).toEqual(['attach', 'audio'])
    })
  })
})
