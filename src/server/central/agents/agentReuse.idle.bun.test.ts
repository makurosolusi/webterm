// Bun-only. The reuse policy's browser ports answer through the shared idle classifier: a browser cabled to a finished
// agent is idle (reusable), one cabled to a working agent, leased or on screen is busy, a user's own browser is never offered.
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserState } from '../../../shared/browser.contract'

const root = mkdtempSync(join(tmpdir(), 'agent-reuse-idle-')) // test-only
process.env.HOME = root
process.env.WEBTERM_DATA_DIR = join(root, 'data')
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')

const { freshDb, run } = await import('../guard/controlGuard.testutil')
const { registerWorkspaceLookup } = await import('../workspaceLookup')
const { browserIdlePorts } = await import('./agentReuse.ports')

let db: ReturnType<typeof freshDb>
let unregister = (): void => undefined
beforeEach(() => { db = freshDb() })
afterEach(() => { unregister(); db.close() })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const st = (id: string, patch: Partial<BrowserState> = {}): BrowserState => ({ id, url: 'about:blank', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live', ...patch })
const agent = (id: string, node: string, state: string): void => run(db, "INSERT OR IGNORE INTO central_agents (id, project_id, kind, runner, node_id, state, owner, started_at) VALUES (?, 'p1', 'claude', 'pty', ?, ?, 'central:global', 1)", id, node, state)

function ports(states: Record<string, BrowserState>, focus: string | null = null) {
  agent('done', 'n-done', 'candidate_done')
  agent('live', 'n-live', 'working')
  const nodes = [...Object.keys(states).map((id) => ({ id, kind: 'browser' })), { id: 'n-done', kind: 'agent' }, { id: 'n-live', kind: 'agent' }]
  const bridges = [{ source: 'n-done', target: 'br-done' }, { source: 'n-live', target: 'br-live' }]
  unregister = registerWorkspaceLookup((id) => (id === 'w1' ? { name: id, nodes, bridges } as never : null))
  return browserIdlePorts({ state: (id) => states[id], focused: () => focus, workspaceIdOf: () => 'w1' })
}

test('idleBrowsers offers the Central browser of a finished agent and nothing busy or user-owned', () => {
  const p = ports({ 'br-done': st('br-done'), 'br-live': st('br-live'), 'br-lease': st('br-lease', { lease: 'agent' }), 'br-free': st('br-free'), ub: st('ub') })
  expect(p.idleBrowsers(db, 'p1')).toEqual(['br-done', 'br-free'])
})

test('browserBusy: leased, focused and active-agent browsers are busy; finished-agent and user browsers are not "in use"', () => {
  const p = ports({ 'br-done': st('br-done'), 'br-live': st('br-live'), 'br-lease': st('br-lease', { lease: 'agent' }), ub: st('ub') }, 'br-done')
  expect(p.browserBusy(db, 'br-lease')).toBe(true)
  expect(p.browserBusy(db, 'br-live')).toBe(true)
  expect(p.browserBusy(db, 'br-done')).toBe(true) // focused by the user
  expect(p.browserBusy(db, 'ub')).toBe(false)
  const q = ports({ 'br-done': st('br-done'), 'br-live': st('br-live'), 'br-lease': st('br-lease', { lease: 'agent' }), ub: st('ub') })
  expect(q.browserBusy(db, 'br-done')).toBe(false)
})
