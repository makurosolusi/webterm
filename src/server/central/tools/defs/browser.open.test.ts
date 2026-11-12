import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAgentStore } from '../../agents/agentStore'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import { createBrowserDefs } from './browser.act'
import { BROWSER_TOOLS_FLAG, type BrowserToolDeps } from './browser.status'

const T0 = 1_700_000_000_000 // test-only
let f: Fixture
beforeEach(() => { f = openFixture(); seedPortfolio(f.db) })
afterEach(() => f.close())

function rig(result: Awaited<ReturnType<NonNullable<BrowserToolDeps['open']>>> = { ok: true, started: true }) {
  const opened: [string, string][] = []
  const deps: BrowserToolDeps = {
    state: () => undefined, listDomains: () => [], control: async () => ({ status: 200 }),
    open: async (requester, nodeId) => { opened.push([requester, nodeId]); return result },
  }
  const registry = createRegistry()
  createBrowserDefs(deps).forEach((d) => registry.register(d))
  const agents = createAgentStore(f.db, () => T0)
  const agent = (id: string, runner: 'pty' | 'exec' = 'pty') => {
    agents.create({ id, projectId: 'p1', kind: 'claude', role: 'worker', runner, owner: 'central:c', reqId: `r-${id}` })
    for (const to of ['provisioning', 'starting'] as const) agents.transition(id, to)
    return agents.transition(id, 'working', runner === 'pty' ? { nodeId: `c-${id}` } : {})
  }
  const run = (args: Record<string, unknown>) => execTool({ db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R1', conversationId: 'global', now: () => T0, env: { [BROWSER_TOOLS_FLAG]: 'on' } }, 'browser_open', { projectId: 'p1', ...args })
  return { opened, agent, agents, run, registry }
}

describe('browser_open', () => {
  it('opens the browser beside the agent node, cabled to it, at R1 under the given node id', async () => {
    const s = rig()
    s.agent('ag-1')
    expect(s.registry.get('browser_open')?.tier).toBe('R1')
    const r = await s.run({ agentRef: 'ag-1', nodeId: 'br-pb_1' })
    expect(r).toMatchObject({ ok: true, data: { nodeId: 'br-pb_1', agentId: 'ag-1', agentNode: 'c-ag-1', started: true } })
    expect(s.opened).toEqual([['c-ag-1', 'br-pb_1']])
  })

  it('refuses an agent of another project, a headless one and an ended one; passes the open refusal on', async () => {
    const s = rig({ ok: false, code: 'disabled' })
    expect((await s.run({ agentRef: 'nope' })).code).toBe('agent_not_found')
    s.agent('ag-x', 'exec')
    expect((await s.run({ agentRef: 'ag-x' })).code).toBe('agent_not_active')
    s.agent('ag-2')
    s.agents.transition('ag-2', 'session_exited')
    expect((await s.run({ agentRef: 'ag-2' })).code).toBe('agent_not_active')
    s.agent('ag-3')
    expect((await s.run({ agentRef: 'ag-3' })).code).toBe('disabled')
    expect(s.opened).toEqual([['c-ag-3', expect.stringMatching(/^br-/)]])
  })

  it('is not registered when the runtime cannot open nodes', () => {
    const registry = createRegistry()
    createBrowserDefs({ state: () => undefined, listDomains: () => [], control: async () => ({ status: 200 }) }).forEach((d) => registry.register(d))
    expect(registry.get('browser_open')).toBeUndefined()
  })
})
