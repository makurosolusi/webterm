import { afterEach, describe, expect, it } from 'vitest'
import type { Workspace, WsNode } from '../../shared/workspace'
import { adaptGatewayHost } from './browser.runtime.parts'
import { createTabsService, tabPersister } from './browser.runtime.tabs'
import { BrowserLifecycle } from './browserLifecycle.service'
import { makeHostRig, stubGuard } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
let lifecycle: BrowserLifecycle
afterEach(async () => { lifecycle?.dispose(); await rig?.stop() })

function setup(maxLive: number) {
  const nodes: WsNode[] = [{ id: 'n1', kind: 'browser', x: 0, y: 0, url: 'https://a.test/' }]
  const ws = { id: 'w1', nodes, bridges: [] } as unknown as Workspace
  const updates: unknown[] = []
  const canvas = {
    add: (i: { nodes: WsNode[] }) => { nodes.push(...i.nodes); return { ok: true as const, updatedAt: 1, nodes: i.nodes } },
    remove: (i: { nodeIds: string[] }) => { for (const id of i.nodeIds) nodes.splice(nodes.findIndex((n) => n.id === id), 1); return { ok: true as const, workspace: ws, removed: [] } },
    update: (i: unknown) => { updates.push(i); return { ok: true as const, updatedAt: 2, nodes: [], bridges: [], unlinked: [] } },
    workspaceOfNode: (id: string) => (nodes.some((n) => n.id === id) ? ws : null),
  }
  return { nodes, ws, updates, canvas, maxLive }
}

async function boot(maxLive: number) {
  const s = setup(maxLive)
  rig = await makeHostRig(stubGuard(), { profileOf: (id) => (id === 'n1' ? 'prof-x' : 'prof-x') })
  lifecycle = new BrowserLifecycle({ maxLive, discardMs: 60_000, host: rig.host, driven: () => false })
  const gwHost = adaptGatewayHost(rig.host, lifecycle)
  const svc = createTabsService({ host: rig.host, lifecycle, gwHost, hub: { count: () => 1 }, workspaces: () => [s.ws], canvas: async () => s.canvas, profileOf: () => 'prof-x' })
  await gwHost.open('n1', 'w1', 'https://a.test/')
  return { ...s, svc }
}

describe('tabs service', () => {
  it('pop-out makes a new browser node on the same profile at the tab url and removes the tab from the source', async () => {
    const { svc, nodes } = await boot(3)
    const t = (await svc.newTab('n1', { url: 'https://b.test/' })).tab!
    const out = await svc.popOut('n1', t.tabId)
    expect(out.newNodeId).toBeDefined()
    expect(out.state.tabs.map((x) => x.url)).toEqual(['https://a.test/'])
    const made = nodes.find((n) => n.id === out.newNodeId)
    expect(made).toMatchObject({ kind: 'browser', url: 'https://b.test/', profileId: 'prof-x' })
    expect(rig.host.state(out.newNodeId!)?.live).toBe('live')
  })

  it('pop-out respects MAX_LIVE: nothing changes when the gate is full', async () => {
    const { svc, nodes } = await boot(1)
    const t = (await svc.newTab('n1', { url: 'https://b.test/' })).tab!
    await expect(svc.popOut('n1', t.tabId)).rejects.toMatchObject({ reason: 'max_live' })
    expect(nodes).toHaveLength(1)
    expect(rig.host.tabsState('n1')?.tabs).toHaveLength(2)
  })

  it('a node the host has not opened answers with the board list as discarded tabs; a node without tabs is empty', async () => {
    const { svc, nodes } = await boot(3)
    nodes.push({ id: 'old', kind: 'browser', x: 0, y: 0 }, { id: 'saved', kind: 'browser', x: 0, y: 0, tabs: { tabs: [{ tabId: 't1', url: 'https://s.test/', title: 'S' }], activeTabId: 't1', agentTabId: 't1' } })
    expect(svc.get('old')?.state.tabs).toEqual([])
    expect(svc.get('saved')?.state.tabs).toMatchObject([{ tabId: 't1', discarded: true, url: 'https://s.test/' }])
    expect(svc.get('nope')).toBeNull()
  })

  it('tabPersister writes the list through canvas.update', async () => {
    const { canvas, updates } = setup(3)
    tabPersister(async () => canvas)('n1', { tabs: [{ tabId: 'a', url: 'https://a.test/', title: '' }], activeTabId: 'a', agentTabId: 'a' })
    await new Promise((r) => setTimeout(r, 20))
    expect(updates).toMatchObject([{ workspaceId: 'w1', patches: [{ id: 'n1', tabs: { activeTabId: 'a' } }] }])
  })
})
