// A crashed node (target lost) is `discarded` in the real host, so every rebuild entry must cross the MAX_LIVE gate.
import { afterEach, describe, expect, it } from 'vitest'
import { adaptGatewayHost } from './browser.runtime.parts'
import { BrowserLifecycle } from './browserLifecycle.service'
import { CDP, CDP_EVENT } from './cdp.client'
import { makeHostRig, waitFor } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })

const MIN = 60_000
const createTargets = () => rig.fake.calls.filter((c) => c.method === CDP.createTarget).length

/** Real host + real lifecycle at `maxLive`; node n1 is attached then crashed by a detach event. */
async function crashed(maxLive: number) {
  rig = await makeHostRig()
  const lc = new BrowserLifecycle({ host: rig.host, maxLive, discardMs: 5 * MIN, driven: () => false })
  const gw = adaptGatewayHost(rig.host, lc)
  await lc.attach('n1', 'w1', 'https://one.test/')
  rig.fake.emit(CDP_EVENT.detachedFromTarget, { sessionId: 'S-T1', targetId: 'T1' })
  await waitFor(() => rig.host.state('n1')?.live === 'discarded', 'crash')
  return { lc, gw }
}
type Gw = Awaited<ReturnType<typeof crashed>>['gw']

describe.each([
  ['nav reload', (gw: Gw) => gw.navAction('n1', 'reload')],
  ['nav go', (gw: Gw) => gw.navAction('n1', 'go', 'https://new.test/')],
  ['navigate', (gw: Gw) => gw.navigate('n1', 'https://new.test/')],
])('gateway %s on a crashed node', (_n, act) => {
  it('at the cap with every live node visible it fails with max_live and opens nothing', async () => {
    const { lc, gw } = await crashed(1)
    await lc.attach('n2', 'w1', 'https://two.test/')
    const before = createTargets()
    await expect(act(gw)).rejects.toMatchObject({ reason: 'max_live' })
    expect(createTargets()).toBe(before)
  })

  it('at the cap it evicts the oldest hidden live node and tracks the recovered one', async () => {
    const { lc, gw } = await crashed(1)
    await lc.attach('n2', 'w1', 'https://two.test/')
    lc.setVisible('n2', false)
    await act(gw)
    expect(rig.host.state('n2')?.live).toBe('discarded')
    expect(rig.host.state('n1')?.live).toBe('live')
    expect(lc.tier('n1')).toBe('live')
  })

  it('under the cap the recovered node is tracked', async () => {
    const { lc, gw } = await crashed(2)
    await act(gw)
    expect(rig.host.state('n1')?.live).toBe('live')
    expect(lc.tier('n1')).toBe('live')
  })
})

it('reload of a live node does not touch the gate', async () => {
  const { lc, gw } = await crashed(1)
  await gw.navAction('n1', 'reload')
  const before = createTargets()
  await gw.navAction('n1', 'reload')
  expect(createTargets()).toBe(before)
  expect(lc.tier('n1')).toBe('live')
})
