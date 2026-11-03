import { describe, expect, it } from 'vitest'
import { FRAME_MAX_BUFFERED_BYTES, MAX_FRAMES_IN_FLIGHT } from '../../shared/browser.contract'
import type { ServerMsg } from '../../shared/browser.contract'
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
  const sinkOf = (buffered: number) => {
    const sent: Uint8Array[] = []
    const msgs: ServerMsg[] = []
    const v: Viewer = { sink: { get bufferedAmount() { return buffered }, sendBinary: (b) => { sent.push(b); return true }, sendJson: (m) => { msgs.push(m) } } }
    return { v, sent, msgs }
  }

  it('drops frames for a viewer whose socket buffer is full and acks the host instead of queueing', async () => {
    const host = new FakeHost()
    const hub = createViewerHub(host, new FakeLeases())
    const slow = sinkOf(FRAME_MAX_BUFFERED_BYTES + 1)
    hub.join('n1', slow.v)
    await hub.sync('n1')
    for (let s = 1; s <= 50; s++) host.emitFrame('n1', s)
    expect(slow.sent).toHaveLength(0)
    expect(host.acks).toHaveLength(50) // tidak ada frame yang ditahan di memori
  })

  it('sends to a fast viewer while a slow viewer drops, and waits only for the fast viewer ack', async () => {
    const host = new FakeHost()
    const hub = createViewerHub(host, new FakeLeases())
    const slow = sinkOf(FRAME_MAX_BUFFERED_BYTES + 1), fast = sinkOf(0)
    hub.join('n1', slow.v)
    hub.join('n1', fast.v)
    await hub.sync('n1')
    host.emitFrame('n1', 1)
    expect(fast.sent).toHaveLength(1)
    expect(host.acks).toEqual([])
    hub.ack('n1', fast.v, 1)
    expect(host.acks).toEqual([['n1', 1]])
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
