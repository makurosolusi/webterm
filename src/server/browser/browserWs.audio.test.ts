import { describe, expect, it } from 'vitest'
import { createAudioLane } from './browserWs.audio'
import type { ViewerSink } from './browserWs.viewers'

function sink(buffered = 0, open = true) {
  const sent: number[] = []
  const s = {
    bufferedAmount: buffered,
    sendBinary: (b: Uint8Array) => { if (!open) return false; sent.push(b[0]); return true },
    sendJson: () => undefined,
  } satisfies { bufferedAmount: number } & Omit<ViewerSink, 'bufferedAmount'>
  return { s, sent }
}

describe('audio lane', () => {
  it('sends straight through when the socket is free', () => {
    const k = sink(); const lane = createAudioLane(k.s)
    lane.push(new Uint8Array([1])); lane.push(new Uint8Array([2]))
    expect(k.sent).toEqual([1, 2])
  })

  it('holds chunks while the socket is backed up and drops the OLDEST beyond the backlog', () => {
    const k = sink(10_000); const lane = createAudioLane(k.s, 3, 100)
    for (let i = 1; i <= 5; i++) lane.push(new Uint8Array([i]))
    expect(k.sent).toEqual([])
    expect(lane.depth).toBe(3)
    k.s.bufferedAmount = 0
    lane.push(new Uint8Array([6]))
    expect(k.sent).toEqual([4, 5, 6]) // 1-3 were dropped as too old
  })

  it('gives up on a closed socket', () => {
    const closed = sink(0, false); const lane = createAudioLane(closed.s)
    lane.push(new Uint8Array([1]))
    expect(lane.depth).toBe(0)
  })
})
