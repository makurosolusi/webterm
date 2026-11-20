import { describe, expect, it } from 'vitest'
import { FRAME_MAX_BUFFERED_BYTES, MAX_FRAMES_IN_FLIGHT } from '../../shared/browser.contract'
import type { ServerMsg } from '../../shared/browser.contract'
import { decodeFrameHeader } from '../../shared/browser.wire'
import { createFrameGate, createSerialQueue } from './browserWs.backpressure'
import { createViewerHub } from './browserWs.viewers'
import type { Viewer } from './browserWs.viewers'
import { FakeHost, FakeLeases } from './browserWs.testkit'

describe('createFrameGate', () => {
  it('admits at most MAX_FRAMES_IN_FLIGHT until acked', () => {
    const g = createFrameGate()
    const verdicts = Array.from({ length: MAX_FRAMES_IN_FLIGHT + 1 }, (_, i) => g.admit(i + 1, 0))
    expect(verdicts).toEqual([...Array(MAX_FRAMES_IN_FLIGHT).fill('send'), 'drop'])
    expect(g.ack(1)).toBe(true)
    expect(g.ack(1)).toBe(false) // ack ganda/basi diabaikan
    expect(g.admit(MAX_FRAMES_IN_FLIGHT + 2, 0)).toBe('send')
    expect(g.inflight).toBe(MAX_FRAMES_IN_FLIGHT)
  })

  it('drops when bufferedAmount exceeds the limit and does not count the dropped frame', () => {
    const g = createFrameGate()
    expect(g.admit(1, FRAME_MAX_BUFFERED_BYTES + 1)).toBe('drop')
    expect(g.inflight).toBe(0)
    expect(g.admit(2, FRAME_MAX_BUFFERED_BYTES)).toBe('send')
  })

  it('clear returns the in-flight seqs and empties the gate', () => {
    const g = createFrameGate()
    g.admit(7, 0)
    expect(g.clear()).toEqual([7])
    expect(g.inflight).toBe(0)
  })
})

describe('createSerialQueue', () => {
  it('runs tasks strictly in order and survives a rejected task', async () => {
    const q = createSerialQueue()
    const log: string[] = []
    q.push(async () => { await new Promise((r) => setTimeout(r, 20)); log.push('a') })
    q.push(async () => { throw new Error('boom') })
    q.push(async () => { log.push('c') })
    await new Promise((r) => setTimeout(r, 80))
    expect(log).toEqual(['a', 'c'])
    expect(q.depth).toBe(0)
  })

  it('drops only droppable tasks once the queue is full', async () => {
    const q = createSerialQueue(2)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    q.push(() => gate)
    q.push(async () => undefined)
    expect(q.push(async () => undefined, true)).toBe(false)
    expect(q.push(async () => undefined, false)).toBe(true)
    release()
  })
})

describe('viewer hub frame memory', () => {
  const sinkOf = (initial: number) => {
    const sent: Uint8Array[] = []
    const msgs: ServerMsg[] = []
    const done: Array<() => void> = []
    const t = { buffered: initial, sent, msgs, done, v: undefined as unknown as Viewer }
    t.v = { sink: { get bufferedAmount() { return t.buffered }, sendBinary: (b, d) => { sent.push(b); if (d) done.push(d); return true }, sendJson: (m) => { msgs.push(m) } } }
    return t
  }

  it('holds frames for a viewer whose socket buffer is full and still acks the host on receipt', async () => {
    const host = new FakeHost()
    const hub = createViewerHub(host, new FakeLeases())
    const slow = sinkOf(FRAME_MAX_BUFFERED_BYTES + 1)
    hub.join('n1', slow.v)
    await hub.sync('n1')
    for (let s = 1; s <= 50; s++) host.emitFrame('n1', s)
    expect(slow.sent).toHaveLength(0)
    expect(host.acks).toHaveLength(50) // Chromium tak ditahan klien lambat
  })

  it('sends the pending frame when the previous ws.send completes', async () => {
    const host = new FakeHost()
    const hub = createViewerHub(host, new FakeLeases())
    const v = sinkOf(0)
    hub.join('n1', v.v)
    await hub.sync('n1')
    host.emitFrame('n1', 1)
    v.buffered = FRAME_MAX_BUFFERED_BYTES + 1 // socket penuh: frame 2 & 3 menunggu, 3 menang
    host.emitFrame('n1', 2)
    host.emitFrame('n1', 3)
    v.buffered = 0
    v.done.shift()?.() // callback `ws.send` frame 1
    expect(v.sent.map((b) => decodeFrameHeader(b)?.seq)).toEqual([1, 3])
  })

  it('reports visibility transitions only on the first join and last leave', async () => {
    const host = new FakeHost()
    const seen: string[] = []
    const hub = createViewerHub(host, new FakeLeases(), (id, vis) => seen.push(`${id}:${vis}`))
    const a = sinkOf(0), b = sinkOf(0)
    hub.join('n1', a.v)
    hub.join('n1', b.v)
    await hub.leave('n1', a.v)
    await hub.leave('n1', b.v)
    expect(seen).toEqual(['n1:true', 'n1:false'])
  })
})

describe('frame window vs round trip (fake clock)', () => {
  /** Frames a client behind `rttMs` receives in 1 s from a source at `fps`; the gate admits, the ack returns after one RTT. */
  function delivered(fps: number, rttMs: number, maxInFlight: number): number {
    const g = createFrameGate(maxInFlight)
    let acks: Array<{ at: number; seq: number }> = []
    let sent = 0
    for (let i = 0, t = 0; t < 1000; i++, t = (i * 1000) / fps) {
      for (const a of acks.filter((x) => x.at <= t)) g.ack(a.seq)
      acks = acks.filter((x) => x.at > t)
      if (g.admit(i + 1, 0) === 'send') { sent++; acks.push({ at: t + rttMs, seq: i + 1 }) }
    }
    return sent
  }
  it('the old window of 2 capped a 100 ms link near 20 fps', () => { expect(delivered(60, 100, 2)).toBeLessThanOrEqual(21) })
  it('MAX_FRAMES_IN_FLIGHT sustains 60 fps up to the 100 ms round-trip budget and 30 fps at 150 ms', () => {
    expect(delivered(60, 100, MAX_FRAMES_IN_FLIGHT)).toBeGreaterThanOrEqual(55) // one frame of boundary slack: an ack lands on the tick it frees
    expect(delivered(30, 150, MAX_FRAMES_IN_FLIGHT)).toBeGreaterThanOrEqual(29)
  })
})
