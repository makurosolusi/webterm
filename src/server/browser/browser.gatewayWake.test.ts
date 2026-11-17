import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserState } from '../../shared/browser.contract'
import { adaptGatewayHost } from './browser.runtime.parts'
import type { BrowserHost } from './browserHost.service'
import { BrowserLifecycle } from './browserLifecycle.service'

const MIN = 60_000
const st = (id: string, live: BrowserState['live'], url = `https://${id}.test/`): BrowserState => ({
  id, url, title: '', loading: false, canBack: false, canForward: false, lease: 'human', live,
})

/** Fake raw host mirroring the real one: navigate/reload on a discarded node reopen it directly (the bypass under test). */
function setup(maxLive: number) {
  const states = new Map<string, BrowserState>()
  const set = (s: BrowserState) => { states.set(s.id, s) }
  const host = {
    open: vi.fn(async (id: string, _ws: string, url?: string) => { const s = st(id, 'live', url ?? states.get(id)?.url); set(s); return s }),
    navigate: vi.fn(async (id: string, url: string) => {
      const cur = states.get(id) as BrowserState
      if (cur.live === 'discarded') await host.open(id, 'w', url)
      else set({ ...cur, url })
    }),
    navAction: vi.fn(async (id: string, action: string, url?: string) => {
      if (action === 'go') return host.navigate(id, url as string)
      const cur = states.get(id) as BrowserState
      if (action === 'reload' && cur.live === 'discarded') await host.open(id, 'w', cur.url)
    }),
    workspaceOf: (id: string) => (states.has(id) ? 'w' : undefined),
    stopScreencast: vi.fn(async () => {}),
    discard: vi.fn(async (id: string) => { set({ ...(states.get(id) as BrowserState), live: 'discarded' }) }),
    state: (id: string) => states.get(id),
    onState: () => () => {},
    isLoading: () => false,
  }
  const lc = new BrowserLifecycle({ host: host as never, maxLive, discardMs: 5 * MIN, driven: () => false })
  const gw = adaptGatewayHost(host as unknown as BrowserHost, lc)
  return { host, lc, gw, set }
}

type Gw = ReturnType<typeof setup>['gw']

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe.each([
  ['nav go', (gw: Gw) => gw.navAction('b', 'go', 'https://new.test/')],
  ['nav reload', (gw: Gw) => gw.navAction('b', 'reload')],
  ['navigate', (gw: Gw) => gw.navigate('b', 'https://new.test/')],
])('gateway %s on a discarded node goes through the MAX_LIVE gate', (_n, act) => {
  it('at the cap with every live node visible it fails with max_live and wakes nothing', async () => {
    const { host, lc, gw, set } = setup(1)
    await lc.attach('a', 'w')
    set(st('b', 'discarded'))
    await expect(act(gw)).rejects.toMatchObject({ reason: 'max_live' })
    expect(host.open).toHaveBeenCalledTimes(1)
    expect((host.state('b') as BrowserState).live).toBe('discarded')
  })

  it('at the cap it evicts the oldest hidden live node and tracks the woken one', async () => {
    const { host, lc, gw, set } = setup(1)
    await lc.attach('a', 'w')
    lc.setVisible('a', false)
    set(st('b', 'discarded'))
    await act(gw)
    expect(host.discard).toHaveBeenCalledWith('a')
    expect(lc.tier('b')).toBe('live')
  })

  it('under the cap the woken node is tracked and discarded by the timer once hidden', async () => {
    const { host, lc, gw, set } = setup(2)
    set(st('b', 'discarded'))
    await act(gw)
    expect(lc.tier('b')).toBe('live')
    lc.setVisible('b', false)
    await vi.advanceTimersByTimeAsync(5 * MIN + 1)
    expect(host.discard).toHaveBeenCalledWith('b')
  })
})

it('nav go on a live node still navigates directly', async () => {
  const { host, gw, set } = setup(1)
  set(st('a', 'live'))
  await gw.navAction('a', 'go', 'https://x.test/')
  expect(host.navigate).toHaveBeenCalledWith('a', 'https://x.test/')
})
