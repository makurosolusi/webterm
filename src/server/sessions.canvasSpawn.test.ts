// Canvas door of `agent.spawn` (F2-h): a new agent session opened over the socket goes through the
// spawner; re-attach and plain shells do not. Fake PTY, rigged spawner.
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { Sessions } from './sessions'
import { FakePty } from './fakePty.testutil'
import { createAgentSpawner, resetAgentSpawnerForTest } from './spawn/agentSpawn'

// test-only rig
function rig() {
  const events: { kind: string; actor?: string; payload: unknown }[] = []
  const lineage: [string, string][] = []
  resetAgentSpawnerForTest(createAgentSpawner({ ancestors: () => [], registerSpawn: (p, c) => { lineage.push([p, c]) }, record: (e) => { events.push({ kind: e.kind, actor: e.actor, payload: e.payload }) }, onPtyExit: () => {} }))
  let fail = false
  const ptys: FakePty[] = []
  const sessions = new Sessions({
    spawn: () => { if (fail) throw new Error('pty refused'); const p = new FakePty(1000 + ptys.length); ptys.push(p); return p },
    now: () => 1_700_000_000_000,
  })
  return { sessions, events, lineage, ptys, failNext: () => { fail = true } }
}
const send = (): void => {}
/** Lineage and events are written after the (synchronous) open, once the spawn promise settles. */
const settle = () => new Promise((res) => setTimeout(res, 0))
const openAgent = (id: string) => ({ t: 'open' as const, id, cols: 80, rows: 24, agentId: 'claude' as const })

describe('canvas open routes through agent.spawn', () => {
  afterEach(() => resetAgentSpawnerForTest())

  it('a new agent node opens synchronously, under human-ui, with one agent.spawn (door canvas)', async () => {
    const r = rig()
    r.sessions.handle(openAgent('n1'), send)
    expect(r.sessions.isLive('n1')).toBe(true)
    expect(r.ptys).toHaveLength(1)
    await settle()
    expect(r.lineage).toEqual([['human-ui', 'node:n1']])
    expect(r.events).toEqual([{ kind: 'agent.spawn', actor: 'human-ui', payload: { kind: 'claude', mode: 'pty', door: 'canvas', depth: 1, name: 'claude' } }])
  })

  it('re-attach to a live session and plain shells bypass the spawner', async () => {
    const r = rig()
    r.sessions.handle(openAgent('n1'), send)
    r.sessions.handle(openAgent('n1'), send)
    r.sessions.handle({ t: 'open', id: 'sh1', cols: 80, rows: 24 }, send)
    expect(r.ptys).toHaveLength(2)
    await settle()
    expect(r.events.filter((e) => e.kind === 'agent.spawn')).toHaveLength(1)
  })

  it('a PTY that fails to start records nothing and the node hears exactly one failed exit (A1)', async () => {
    const r = rig()
    r.failNext()
    const seen: ServerMsg[] = []
    r.sessions.handle(openAgent('n2'), (m) => { seen.push(m) })
    await settle()
    expect(r.events).toEqual([])
    expect(r.lineage).toEqual([])
    expect(seen.filter((m) => m.t === 'exit')).toEqual([{ t: 'exit', id: 'n2', code: -1, reason: 'failed' }])
    expect(seen.some((m) => m.t === 'output' && m.data.includes('could not start: pty refused'))).toBe(true)
    expect(seen).toContainEqual({ t: 'status', id: 'n2', status: 'failed' })
    expect(r.sessions.statusOf('n2')).toBe('failed')
    expect(r.sessions.getExit('n2')?.reason).toBe('failed')
  })
})
