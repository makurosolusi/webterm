import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockedError } from '../../shared/browser.contract'
import type { BrowserHostApi, BrowserState } from '../../shared/browser.contract'
import { SnapshotStore } from './browserAgent.snapshot'
import { createAgentVerbs } from './browserAgent.verbs'
import { BrowserLifecycle } from './browserLifecycle.service'
import { LeaseService } from './browserLease.service'

const MIN = 60_000
const st = (id: string, live: BrowserState['live'], url = `https://${id}.test/`): BrowserState => ({
  id, url, title: '', loading: false, canBack: false, canForward: false, lease: 'human', live,
})

/** Fake host mirroring the real one: `navigate` on a discarded node reopens it directly (the gate bypass under test). */
function setup(maxLive: number) {
  const states = new Map<string, BrowserState>()
  const cbs = new Set<(s: BrowserState) => void>()
  const set = (s: BrowserState) => { states.set(s.id, s); cbs.forEach((cb) => cb(s)) }
  const host = {
    open: vi.fn(async (id: string, _ws: string, url?: string) => { const s = st(id, 'live', url ?? states.get(id)?.url); set(s); return s }),
    navigate: vi.fn(async (id: string, url: string) => {
      const cur = states.get(id) as BrowserState
      if (cur.live === 'discarded') await host.open(id, 'w', url)
      else set({ ...cur, url })
    }),
    stopScreencast: vi.fn(async () => {}),
    discard: vi.fn(async (id: string) => { set({ ...(states.get(id) as BrowserState), live: 'discarded' }) }),
    state: (id: string) => states.get(id),
    onState: (cb: (s: BrowserState) => void) => { cbs.add(cb); return () => { cbs.delete(cb) } },
    isLoading: () => false,
  }
  const api = host as unknown as BrowserHostApi
  const lc = new BrowserLifecycle({ host: api, maxLive, discardMs: 5 * MIN, driven: () => false })
  let t = 0
  const verbs = createAgentVerbs({
    host: api, leases: new LeaseService(() => t), snapshots: new SnapshotStore(), agentAllowed: () => true,
    sleep: async (ms) => { t += ms }, now: () => t,
    wake: async (id, url) => { const r = await lc.attach(id, 'w', url); if (!r.ok) throw new BlockedError(r.blocked) },
  })
  return { host, lc, verbs, set }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('navigate on a discarded node goes through the MAX_LIVE gate', () => {
  it('at the cap it evicts the oldest hidden live node and tracks the woken one', async () => {
    const { host, lc, verbs, set } = setup(1)
    await lc.attach('a', 'w')
    lc.setVisible('a', false)
    set(st('b', 'discarded'))
    await verbs.navigate('b', { url: 'https://new.test/' })
    expect(host.discard).toHaveBeenCalledWith('a')
    expect(lc.tier('b')).toBe('live')
    expect((host.state('b') as BrowserState).url).toBe('https://new.test/')
    expect(host.navigate).not.toHaveBeenCalled() // opened at the url already: no second load
  })

  it('at the cap with every live node visible it fails with a typed max_live and wakes nothing', async () => {
    const { host, lc, verbs, set } = setup(1)
    await lc.attach('a', 'w')
    set(st('b', 'discarded'))
    await expect(verbs.navigate('b', { url: 'https://new.test/' })).rejects.toMatchObject({ reason: 'max_live' })
    expect(host.open).toHaveBeenCalledTimes(1)
    expect((host.state('b') as BrowserState).live).toBe('discarded')
  })

  it('a woken node is discarded again by the lifecycle timer once hidden', async () => {
    const { host, lc, verbs, set } = setup(2)
    set(st('b', 'discarded'))
    await verbs.navigate('b', { url: 'https://new.test/' })
    lc.setVisible('b', false)
    await vi.advanceTimersByTimeAsync(5 * MIN + 1)
    expect(host.discard).toHaveBeenCalledWith('b')
  })

  it('a live node navigates as before, without waking', async () => {
    const { host, verbs, set } = setup(1)
    set(st('a', 'live'))
    await verbs.navigate('a', { url: 'https://x.test/' })
    expect(host.navigate).toHaveBeenCalledWith('a', 'https://x.test/')
  })
})
