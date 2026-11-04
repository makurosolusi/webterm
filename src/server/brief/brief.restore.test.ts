// Boot-time adoption emits `agent.restored` for every re-adopted AGENT session (not plain shells,
// not orphans) — the morning brief's "restored after restart" lines come from these events.
import { afterEach, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eventBus } from '../events/eventBus'
import type { SenseEvent } from '../events/eventModel'
import { Sessions } from '../sessions'
import type { SupervisedSession, TmuxSupervisor } from '../ptySupervisor'
import { FakePty } from '../fakePty.testutil'

process.env.WEBTERM_DATA_DIR = mkdtempSync(join(tmpdir(), 'webterm-brief-restore-')) // node header files land here

let off: (() => void) | null = null
afterEach(() => off?.())

test('adoptSupervised records agent.restored per adopted agent session', () => {
  const live: SupervisedSession[] = [
    { id: 'agent1', cols: 80, rows: 24, agentId: 'claude', orphan: false, history: 0 },
    { id: 'shell1', cols: 80, rows: 24, orphan: false, history: 0 },
    { id: 'gone1', cols: 80, rows: 24, agentId: 'claude', orphan: false, history: 0 },
  ]
  const supervisor = {
    list: () => live,
    attach: () => new FakePty(),
    capture: () => undefined,
    markOrphan: () => {},
  } as unknown as TmuxSupervisor
  const seen: SenseEvent[] = []
  off = eventBus.subscribe('agent.restored', (e) => { seen.push(e) })
  const res = new Sessions({}, supervisor).adoptSupervised((id) => id !== 'gone1')
  expect(res).toEqual({ adopted: ['agent1', 'shell1'], orphans: ['gone1'] })
  expect(seen.map((e) => [e.kind, e.nodeId, e.payload])).toEqual([['agent.restored', 'agent1', { agentId: 'claude' }]])
})
