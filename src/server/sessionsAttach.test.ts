// Attach-path contract of `Sessions` with a fake PTY: the DA reply gate, the kind gate, detach,
// and seq/epoch replay (pty-207-1, -6, -8, -9).
import { describe, expect, test } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { Sessions } from './sessions'
import { FakePty } from './fakePty.testutil'

const T0 = 1_700_000_000_000 // test-only
const DA1_QUERY = '\x1b[c'
const DA1_REPLY = '\x1b[?1;2c' // what xterm.js answers to CSI c

function harness(now: () => number = () => T0) {
  const ptys: FakePty[] = []
  const sessions = new Sessions({ spawn: () => { const p = new FakePty(1000 + ptys.length); ptys.push(p); return p }, now })
  const socket = () => {
    const got: ServerMsg[] = []
    const send = (m: ServerMsg): void => { got.push(m) }
    return { got, send, outputs: () => got.filter((m) => m.t === 'output').map((m) => (m as { data: string }).data) }
  }
  return { sessions, ptys, socket }
}

describe('DA reply gate (pty-207-1)', () => {
  test('a live DA query gets exactly one reply through, however many viewers answer', () => {
    const { sessions, ptys, socket } = harness()
    sessions.open({ t: 'open', id: 'd1', cols: 80, rows: 24 }, socket().send)
    ptys[0].emitData(`hello${DA1_QUERY}`)
    sessions.input('d1', DA1_REPLY)
    sessions.input('d1', DA1_REPLY)
    expect(ptys[0].writes).toEqual([DA1_REPLY])
  })

  test('a replayed query opens no slot: the re-answer of a new viewer never reaches the shell', () => {
    const { sessions, ptys, socket } = harness()
    const a = socket()
    sessions.open({ t: 'open', id: 'd2', cols: 80, rows: 24 }, a.send)
    ptys[0].emitData(DA1_QUERY)
    sessions.input('d2', DA1_REPLY) // first viewer answers the live query
    const b = socket()
    sessions.open({ t: 'open', id: 'd2', cols: 80, rows: 24 }, b.send) // remount/reconnect replay
    expect(b.outputs().join('')).toContain(DA1_QUERY)
    sessions.input('d2', `${DA1_REPLY}\x1b[>0;276;0c`) // its xterm re-answers the replayed queries
    expect(ptys[0].writes).toEqual([DA1_REPLY])
  })

  test('a keystroke or paste that merely contains a reply passes through untouched', () => {
    const { sessions, ptys, socket } = harness()
    sessions.open({ t: 'open', id: 'd3', cols: 80, rows: 24 }, socket().send)
    sessions.input('d3', `ls${DA1_REPLY}`)
    sessions.input('d3', 'x')
    expect(ptys[0].writes).toEqual([`ls${DA1_REPLY}`, 'x'])
  })
})

describe('kind gate (pty-207-6)', () => {
  test('a plain open on an id held by an agent session gets a mismatch notice, never the agent', () => {
    const { sessions, ptys, socket } = harness()
    sessions.open({ t: 'open', id: 'T', cols: 80, rows: 24, cmd: 'codex', agentId: 'codex' }, () => {})
    ptys[0].emitData('[agent running: codex]')
    const plain = socket()
    sessions.open({ t: 'open', id: 'T', cols: 80, rows: 24 }, plain.send)
    expect(plain.outputs().join('')).not.toContain('agent running')
    expect(plain.outputs().join('')).toContain('already running the codex agent')
    expect(plain.got.at(-1)).toEqual({ t: 'exit', id: 'T', code: -1, reason: 'kind_mismatch' })
    ptys[0].emitData('more agent output')
    expect(plain.outputs().join('')).not.toContain('more agent output')
    expect(ptys).toHaveLength(1)
  })

  test('the same kind re-attaches as before', () => {
    const { sessions, ptys, socket } = harness()
    sessions.open({ t: 'open', id: 'S', cols: 80, rows: 24, agentId: 'codex' }, () => {})
    ptys[0].emitData('agent-screen')
    const again = socket()
    sessions.open({ t: 'open', id: 'S', cols: 80, rows: 24, agentId: 'codex' }, again.send)
    expect(again.outputs()).toEqual(['agent-screen'])
  })
})

describe('detach (pty-207-8)', () => {
  test('a detached view gets no more output while the session keeps running', () => {
    const { sessions, ptys, socket } = harness()
    const view = socket()
    sessions.handle({ t: 'open', id: 'u1', cols: 80, rows: 24 }, view.send)
    ptys[0].emitData('before')
    sessions.handle({ t: 'detach', id: 'u1' }, view.send)
    ptys[0].emitData('after')
    expect(view.outputs()).toEqual(['before'])
    expect(sessions.isLive('u1')).toBe(true)
    expect(ptys[0].killed).toBe(0)
  })
})

describe('seq/epoch replay (pty-207-9)', () => {
  test('a new session starts with reset, then its output, numbered from 1', () => {
    const { sessions, ptys, socket } = harness()
    const s = socket()
    sessions.open({ t: 'open', id: 'r1', cols: 80, rows: 24 }, s.send)
    ptys[0].emitData('a')
    expect(s.got[0]).toMatchObject({ t: 'reset', id: 'r1' })
    expect(s.got.find((m) => m.t === 'output')).toMatchObject({ data: 'a', seq: 1 })
  })

  test('a re-attach with `since` of the same epoch replays only the gap, with no reset', () => {
    const { sessions, ptys, socket } = harness()
    const first = socket()
    sessions.open({ t: 'open', id: 'r2', cols: 80, rows: 24 }, first.send)
    const epoch = (first.got[0] as { epoch: string }).epoch
    for (const d of ['a', 'b', 'c']) ptys[0].emitData(d)
    const again = socket()
    sessions.open({ t: 'open', id: 'r2', cols: 80, rows: 24, since: { epoch, seq: 2 } }, again.send)
    expect(again.got.map((m) => m.t)).toEqual(['output', 'status'])
    expect(again.outputs()).toEqual(['c'])
  })

  test('a `since` of another epoch, or below what the log still holds, gets reset + the whole log', () => {
    const { sessions, ptys, socket } = harness()
    sessions.open({ t: 'open', id: 'r3', cols: 80, rows: 24 }, () => {})
    for (const d of ['a', 'b']) ptys[0].emitData(d)
    const stale = socket()
    sessions.open({ t: 'open', id: 'r3', cols: 80, rows: 24, since: { epoch: 'other-1', seq: 1 } }, stale.send)
    expect(stale.got[0]).toMatchObject({ t: 'reset' })
    expect(stale.outputs()).toEqual(['a', 'b'])
    const ahead = socket()
    sessions.open({ t: 'open', id: 'r3', cols: 80, rows: 24, since: { epoch: (stale.got[0] as { epoch: string }).epoch, seq: 99 } }, ahead.send)
    expect(ahead.got[0]).toMatchObject({ t: 'reset' })
  })

  test('resync of a lagging subscriber sends reset + the whole log, and nothing once it left', () => {
    const { sessions, ptys, socket } = harness()
    const s = socket()
    sessions.open({ t: 'open', id: 'r4', cols: 80, rows: 24 }, s.send)
    ptys[0].emitData('x')
    s.got.length = 0
    sessions.resync('r4', s.send)
    expect(s.got.map((m) => m.t)).toEqual(['reset', 'output'])
    sessions.handle({ t: 'detach', id: 'r4' }, s.send)
    s.got.length = 0
    sessions.resync('r4', s.send)
    expect(s.got).toEqual([])
  })
})
