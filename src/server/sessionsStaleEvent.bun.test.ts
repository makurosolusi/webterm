// `agent.stale`: the stale sweep must leave a trace. Status-only, so no PTY is spawned.
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKING_STALE_MS } from '../shared/agentStale'
import { eventBus } from './events/eventBus'
import type { SenseEvent } from './events/eventModel'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'webterm-stale-event-'))
const ORIGINAL_HOME = process.env.HOME
process.env.WEBTERM_DATA_DIR = DATA_DIR
process.env.HOME = DATA_DIR
afterAll(() => {
  process.env.HOME = ORIGINAL_HOME
  rmSync(DATA_DIR, { recursive: true, force: true })
})

// Dynamic: importing the module builds the singleton, which must see the temp dirs above.
const { Sessions, sessions, recordAgentStale } = await import('./sessions')

const T0 = 1_700_000_000_000
const IDLE = WORKING_STALE_MS + 5_000

let off: (() => void) | null = null
afterEach(() => { off?.(); off = null })

function capture(): SenseEvent[] {
  const seen: SenseEvent[] = []
  off = eventBus.subscribe('agent.stale', (e) => { seen.push(e) })
  return seen
}

/** A Sessions wired like the singleton. */
function wired() {
  const s = new Sessions()
  s.onStaleSweep = recordAgentStale
  return s
}

test('the singleton is wired to the event log', () => {
  expect(sessions.onStaleSweep).toBe(recordAgentStale)
})

test('a swept node emits exactly one agent.stale with its idle time and still loses its status', () => {
  const seen = capture()
  const s = wired()
  s.setStatus('n1', 'working', T0)

  s.sweepStale(T0 + IDLE)

  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({
    kind: 'agent.stale',
    source: 'pty',
    actor: 'system',
    subject: 'node:n1',
    nodeId: 'n1',
    trust: 'trusted',
    payload: { rule: 'stale_sweep', lastStatus: 'working', idleMs: IDLE },
  })
  expect(s.statusOf('n1')).toBe(undefined)

  s.sweepStale(T0 + IDLE + 60_000)
  expect(seen).toHaveLength(1)
})

test('a live working node and a non-working node emit nothing', () => {
  const seen = capture()
  const s = wired()
  s.setStatus('fresh', 'working', T0 + IDLE - 1_000)
  s.setStatus('waits', 'waiting', T0)

  s.sweepStale(T0 + IDLE)

  expect(seen).toHaveLength(0)
  expect(s.statusOf('fresh')).toBe('working')
  expect(s.statusOf('waits')).toBe('waiting')
})

test('a throwing callback does not stop the remaining nodes', () => {
  const s = new Sessions()
  const reached: string[] = []
  s.onStaleSweep = ({ id }) => {
    reached.push(id)
    throw new Error('ledger down')
  }
  s.setStatus('a', 'working', T0)
  s.setStatus('b', 'working', T0)
  s.setStatus('c', 'working', T0)

  s.sweepStale(T0 + IDLE)

  expect(reached).toEqual(['a', 'b', 'c'])
  for (const id of reached) expect(s.statusOf(id)).toBe(undefined)
})
