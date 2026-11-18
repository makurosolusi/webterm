import { afterEach, describe, expect, it } from 'vitest'
import type { AgentVerbs } from './browserAgent.verbs.ctx'
import { agentTabHost, withNewTab } from './browser.agentTabs'
import { CDP, CDP_EVENT } from './cdp.client'
import { makeHostRig, stubGuard, waitFor } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })

async function open(driving: boolean) {
  rig = await makeHostRig(stubGuard(), { agentDriving: () => driving })
  await rig.host.open('n1', 'w1', 'https://a.test/')
}
const popup = () => rig.fake.emit(CDP_EVENT.targetCreated, { targetInfo: { targetId: 'P1', type: 'page', title: '', url: 'https://pop.test/', openerId: 'T1' } })
const mouse = { t: 'mouse', type: 'down', x: 1, y: 2, button: 'left', buttons: 1, clickCount: 1, mods: 0, dx: 0, dy: 0 } as const

describe('agent tab compatibility', () => {
  it('a single-tab node takes the unchanged host path (input goes to the view session)', async () => {
    await open(true)
    await agentTabHost(rig.host).input('n1', mouse)
    await waitFor(() => rig.fake.calls.some((c) => c.method === CDP.mouse), 'mouse')
    expect(rig.fake.calls.find((c) => c.method === CDP.mouse)?.sessionId).toBe('S-T1')
  })

  it('a click that opens a popup reports newTab, moves agentTabId and routes later verbs to that tab', async () => {
    await open(true)
    const first = rig.host.tabApi.agentTab('n1')
    const verbs = withNewTab({ click: async () => { popup(); return { ok: true as const } } } as unknown as AgentVerbs, rig.host)
    const res = await verbs.click('n1', {})
    expect(res.newTab).toBeDefined()
    expect(rig.host.tabApi.agentTab('n1')).toBe(res.newTab)
    expect(res.newTab).not.toBe(first)
    await agentTabHost(rig.host).input('n1', mouse)
    await waitFor(() => rig.fake.calls.some((c) => c.method === CDP.mouse), 'mouse')
    expect(rig.fake.calls.find((c) => c.method === CDP.mouse)?.sessionId).toBe('S-P1')
  })

  it('while the human has chosen their own tab, an agent popup moves only the agent cursor', async () => {
    await open(true)
    const a = rig.host.tabApi.viewTab('n1') as string
    await rig.host.tabApi.activate('n1', a, 'human') // human interaction turns follow-agent off
    popup()
    await waitFor(() => rig.host.tabsState('n1')!.tabs.length === 2, 'popup tab')
    const s = rig.host.tabsState('n1')!
    expect(s.agentTabId).toBe(s.tabs[1].tabId)
    expect(s.activeTabId).toBe(a)
  })

  it('a click without a popup carries no newTab', async () => {
    await open(true)
    const verbs = withNewTab({ click: async () => ({ ok: true as const }) } as unknown as AgentVerbs, rig.host)
    expect(await verbs.click('n1', {})).toEqual({ ok: true })
  })
})
