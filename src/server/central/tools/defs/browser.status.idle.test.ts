import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserState } from '../../../../shared/browser.contract'
import { execWrite } from '../../../ledger/ledgerCore'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import { BROWSER_ACT_FLAG, createBrowserDefs } from './browser.act'
import { BROWSER_TOOLS_FLAG, type BrowserToolDeps } from './browser.status'

let f: Fixture
let unregister = (): void => undefined
beforeEach(() => { f = openFixture(); seedPortfolio(f.db) })
afterEach(() => { unregister(); f.close() })

const st = (id: string, patch: Partial<BrowserState> = {}): BrowserState => ({ id, url: 'https://app.example.com/inbox?token=SECRET#frag', title: 'Inbox', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live', ...patch })
const AGENT_SQL = "INSERT INTO central_agents (id, project_id, kind, runner, node_id, state, owner, started_at) VALUES (?, 'p1', 'claude', 'pty', ?, ?, 'central:global', 1)"

async function status(states: Record<string, BrowserState>, focus: string | null = null) {
  execWrite(f.db, AGENT_SQL, 'ag-done', 'a-done', 'candidate_done')
  execWrite(f.db, AGENT_SQL, 'ag-live', 'a-live', 'working')
  const nodes = [...Object.keys(states).map((id) => ({ id, kind: 'browser' })), { id: 'a-done', kind: 'agent' }, { id: 'a-live', kind: 'agent' }]
  const bridges = [{ source: 'a-done', target: 'br-done' }, { source: 'a-live', target: 'br-busy' }]
  unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? { name: id, nodes, bridges } as never : null))
  const deps: BrowserToolDeps = { state: (id) => states[id], listDomains: () => [{ domain: 'app.example.com' }], control: async () => ({ status: 200 }), focused: () => focus }
  const registry = createRegistry()
  createBrowserDefs(deps).forEach((d) => registry.register(d))
  const env = { [BROWSER_TOOLS_FLAG]: 'on', [BROWSER_ACT_FLAG]: 'on' }
  return execTool({ db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R2', conversationId: 'central:global', now: () => 1, env }, 'browser_status', { projectId: 'p1' })
}

describe('browser_status: idle classification', () => {
  it('lists idle, idleReason, owner and cabledTo per item plus idleCount, from the shared classifier', async () => {
    const res = await status({ 'br-done': st('br-done'), 'br-busy': st('br-busy'), 'br-lease': st('br-lease', { lease: 'agent' }), ub: st('ub') })
    expect(res.ok).toBe(true)
    const data = res.data as { items: Array<Record<string, unknown>>; idleCount: number }
    const by = Object.fromEntries(data.items.map((i) => [String(i.id), i]))
    expect(by['br-done']).toMatchObject({ idle: true, idleReason: 'idle', owner: 'central', cabledTo: { nodeId: 'a-done', agentId: 'ag-done', agentState: 'candidate_done' } })
    expect(by['br-busy']).toMatchObject({ idle: false, idleReason: 'cabled_active_agent', owner: 'central', cabledTo: { agentState: 'working' } })
    expect(by['br-lease']).toMatchObject({ idle: false, idleReason: 'lease_agent' })
    expect(by.ub).toMatchObject({ idle: false, idleReason: 'user_owned', owner: 'user' })
    expect(data.idleCount).toBe(1)
  })
  it('a focused browser is not idle; no cookie value, full URL or page content leaves the tool', async () => {
    const res = await status({ 'br-done': st('br-done') }, 'br-done')
    expect((res.data as { idleCount: number }).idleCount).toBe(0)
    const text = JSON.stringify(res)
    for (const leak of ['SECRET', 'frag', 'inbox', 'token']) expect(text).not.toContain(leak)
  })
  it('the usage text tells Central to reuse an idle central browser before opening a new one', () => {
    const registry = createRegistry()
    createBrowserDefs({ state: () => undefined, listDomains: () => [], control: async () => ({ status: 200 }) }).forEach((d) => registry.register(d))
    const usage = registry.get('browser_status')!.usage
    expect(usage).toMatch(/idleCount/)
    expect(usage).toMatch(/open a new one only when none is idle/)
  })
})
