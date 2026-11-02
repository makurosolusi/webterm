import { afterEach, describe, expect, it, vi } from 'vitest'
import { StreamHub, formatSseFrame, type StreamEvent, type StreamFrame } from './streamHub'

function events(...seqs: number[]): StreamEvent[] {
  return seqs.map((seq) => ({ seq, type: 'part.delta', payload: { delta: String(seq) } }))
}

function sink(): { frames: StreamFrame[]; push: (frame: StreamFrame) => void } {
  const frames: StreamFrame[] = []
  return { frames, push: (frame) => frames.push(frame) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SSE replay and fan-out', () => {
  it('replays strictly after Last-Event-ID, then streams live events', () => {
    const replayed: number[] = []
    const hub = new StreamHub({
      replay: (_id, after) => {
        replayed.push(after)
        return after < 2 ? events(1, 2) : []
      },
      heartbeatMs: 0,
    })
    const out = sink()
    hub.subscribe('central:global', 1, out.push)
    expect(replayed).toEqual([1])
    expect(out.frames).toEqual([
      { kind: 'event', id: 2, event: 'part.delta', data: events(2)[0] },
    ])

    hub.publish('central:global', events(3)[0]!)
    expect(out.frames.map((frame) => frame.kind === 'event' ? frame.id : 'hb')).toEqual([2, 3])
    hub.close()
  })

  it('fills a gap before delivering the live event', () => {
    const hub = new StreamHub({ replay: (_id, after) => after < 3 ? events(1, 2, 3) : [], heartbeatMs: 0 })
    const out = sink()
    hub.subscribe('central:global', 0, out.push)
    expect(out.frames).toHaveLength(3)
    hub.publish('central:global', events(4)[0]!)
    expect(out.frames.map((frame) => frame.kind === 'event' ? frame.id : 'hb')).toEqual([1, 2, 3, 4])
    hub.close()
  })

  it('skips events a subscriber already saw and is per-conversation', () => {
    const hub = new StreamHub({ heartbeatMs: 0 })
    const global = sink()
    const project = sink()
    hub.subscribe('central:global', 5, global.push)
    hub.subscribe('central:project:p1', 0, project.push)
    hub.publish('central:global', events(5)[0]!)
    hub.publish('central:global', events(6)[0]!)
    hub.publish('central:project:p1', events(1)[0]!)
    expect(global.frames).toHaveLength(1)
    expect(project.frames).toHaveLength(1)
    expect(hub.subscriberCount('central:global')).toBe(1)
    hub.close()
    expect(hub.subscriberCount('central:global')).toBe(0)
  })

  it('heartbeats every 15 s and stops on disconnect', () => {
    vi.useFakeTimers()
    const hub = new StreamHub({ heartbeatMs: 15_000 })
    const out = sink()
    const unsubscribe = hub.subscribe('central:global', 0, out.push)
    vi.advanceTimersByTime(14_999)
    expect(out.frames).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(out.frames).toEqual([{ kind: 'heartbeat' }])
    unsubscribe()
    vi.advanceTimersByTime(30_000)
    expect(out.frames).toHaveLength(1)
    expect(hub.subscriberCount('central:global')).toBe(0)
  })

  it('serializes frames as SSE with id/event/data and comments for heartbeats', () => {
    expect(formatSseFrame({ kind: 'event', id: 7, event: 'done', data: { ok: true } }))
      .toBe('id: 7\nevent: done\ndata: {"ok":true}\n\n')
    expect(formatSseFrame({ kind: 'heartbeat' })).toBe(': heartbeat\n\n')
  })
})
