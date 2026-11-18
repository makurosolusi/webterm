import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHostApi, BrowserState } from '../../shared/browser.contract'
import { BrowserLifecycle, DISCARD_RETRY_MS, lifecycleConfig } from './browserLifecycle.service'

const st = (id: string, over: Partial<BrowserState> = {}): BrowserState => ({
  id, url: `https://${id}.test/`, title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live', ...over,
})

function fakeHost() {
  const states = new Map<string, BrowserState>()
  const cbs = new Set<(s: BrowserState) => void>()
  const set = (s: BrowserState) => { states.set(s.id, s); cbs.forEach((cb) => cb(s)) }
  const host = {
    open: vi.fn(async (id: string, _ws: string, url?: string) => {
      const s = st(id, { url: url ?? states.get(id)?.url ?? '' })
      set(s)
      return s
    }),
    stopScreencast: vi.fn(async () => {}),
    discard: vi.fn(async (id: string) => { set({ ...(states.get(id) as BrowserState), live: 'discarded' }) }),
    state: (id: string) => states.get(id),
    onState: (cb: (s: BrowserState) => void) => { cbs.add(cb); return () => { cbs.delete(cb) } },
    isLoading: (id: string) => states.get(id)?.loading ?? false,
  }
  return { host: host as unknown as BrowserHostApi & typeof host, set, states, cbs }
}

const MIN = 60_000
let driven: Set<string>
beforeEach(() => { vi.useFakeTimers(); driven = new Set() })
afterEach(() => { vi.useRealTimers() })

function make(maxLive = 3, discardMs = 5 * MIN) {
  const f = fakeHost()
  const lc = new BrowserLifecycle({ host: f.host, maxLive, discardMs, driven: (id) => driven.has(id) })
  return { ...f, lc }
}

describe('lifecycleConfig', () => {
  it('uses defaults, clamps and rejects junk', () => {
    expect(lifecycleConfig({})).toEqual({ maxLive: 3, discardMs: 300_000 })
    expect(lifecycleConfig({ WEBTERM_BROWSER_MAX_LIVE: '99', WEBTERM_BROWSER_DISCARD_MS: '1000' })).toEqual({ maxLive: 12, discardMs: 1000 })
    expect(lifecycleConfig({ WEBTERM_BROWSER_MAX_LIVE: '0', WEBTERM_BROWSER_DISCARD_MS: 'abc' })).toEqual({ maxLive: 1, discardMs: 300_000 })
  })
})

describe('BrowserLifecycle discard timer', () => {
  it('pauses on hide, discards after discardMs, restores from url on attach', async () => {
    const { lc, host } = make()
    await lc.attach('a', 'w', 'https://a.test/x')
    lc.setVisible('a', false)
    expect(host.stopScreencast).toHaveBeenCalledWith('a')
    expect(lc.tier('a')).toBe('paused')
    await vi.advanceTimersByTimeAsync(5 * MIN - 1)
    expect(host.discard).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(host.discard).toHaveBeenCalledWith('a')
    expect(lc.tier('a')).toBe('discarded')
    const r = await lc.attach('a', 'w')
    expect(host.open).toHaveBeenLastCalledWith('a', 'w', 'https://a.test/x')
    expect(r.ok && r.state.live).toBe('live')
    expect(lc.tier('a')).toBe('live')
  })

  it('becoming visible cancels the timer', async () => {
    const { lc, host } = make()
    await lc.attach('a', 'w')
    lc.setVisible('a', false)
    await vi.advanceTimersByTimeAsync(4 * MIN)
    lc.setVisible('a', true)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(host.discard).not.toHaveBeenCalled()
  })

  it.each([
    ['loading', (f: ReturnType<typeof make>) => f.set({ ...(f.states.get('a') as BrowserState), loading: true }), () => {}],
    ['driven', () => {}, () => driven.add('a')],
  ])('never discards a %s node; retries then discards once clear', async (_n, mkF, mkD) => {
    const f = make()
    await f.lc.attach('a', 'w')
    mkF(f)
    mkD()
    f.lc.setVisible('a', false)
    await vi.advanceTimersByTimeAsync(5 * MIN + 3 * DISCARD_RETRY_MS)
    expect(f.host.discard).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1) // retry still armed
    driven.delete('a')
    f.set({ ...(f.states.get('a') as BrowserState), loading: false })
    await vi.advanceTimersByTimeAsync(DISCARD_RETRY_MS)
    expect(f.host.discard).toHaveBeenCalledTimes(1)
  })

  it('leaves no timers after dispose and ignores later calls', async () => {
    const { lc, host, cbs } = make()
    await lc.attach('a', 'w')
    await lc.attach('b', 'w')
    lc.setVisible('a', false)
    lc.setVisible('b', false)
    expect(vi.getTimerCount()).toBe(2)
    lc.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(cbs.size).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(host.discard).not.toHaveBeenCalled()
    await expect(lc.attach('c', 'w')).rejects.toThrow(/disposed/)
  })

  it('drops tracking when host reports a crash (discarded)', async () => {
    const { lc, set, states } = make()
    await lc.attach('a', 'w')
    lc.setVisible('a', false)
    set({ ...(states.get('a') as BrowserState), live: 'discarded' })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('BrowserLifecycle MAX_LIVE', () => {
  it('evicts the oldest hidden node for the 4th', async () => {
    const { lc, host } = make(3)
    for (const id of ['a', 'b', 'c']) await lc.attach(id, 'w')
    lc.setVisible('b', false)
    await vi.advanceTimersByTimeAsync(1000)
    lc.setVisible('a', false)
    const r = await lc.attach('d', 'w')
    expect(r.ok).toBe(true)
    expect(host.discard).toHaveBeenCalledTimes(1)
    expect(host.discard).toHaveBeenCalledWith('b')
    expect(host.stopScreencast).toHaveBeenCalledWith('b')
    expect(lc.tier('d')).toBe('live')
  })

  it('blocks max_live when all are visible, without touching the host', async () => {
    const { lc, host } = make(2)
    await lc.attach('a', 'w')
    await lc.attach('b', 'w')
    expect(await lc.attach('c', 'w')).toEqual({ ok: false, blocked: 'max_live' })
    expect(host.open).toHaveBeenCalledTimes(2)
    expect(host.discard).not.toHaveBeenCalled()
  })

  it('does not evict hidden nodes that are driven or loading', async () => {
    const { lc, host } = make(1)
    await lc.attach('a', 'w')
    lc.setVisible('a', false)
    driven.add('a')
    expect(await lc.attach('b', 'w')).toEqual({ ok: false, blocked: 'max_live' })
    expect(host.discard).not.toHaveBeenCalled()
  })

  it('re-attaching a tracked node does not need a free slot; concurrent attaches respect the cap', async () => {
    const { lc } = make(2)
    const rs = await Promise.all(['a', 'b', 'c'].map((id) => lc.attach(id, 'w')))
    expect(rs.map((r) => r.ok)).toEqual([true, true, false])
    expect((await lc.attach('a', 'w')).ok).toBe(true)
  })

  it('releases the slot when open fails', async () => {
    const { lc, host } = make(1)
    host.open.mockRejectedValueOnce(new Error('boom'))
    await expect(lc.attach('a', 'w')).rejects.toThrow('boom')
    expect((await lc.attach('b', 'w')).ok).toBe(true)
  })
})

describe('BrowserLifecycle dynamic MAX_LIVE', () => {
  it('a raised limit gives a slot at once, a lowered one evicts hidden nodes only', async () => {
    let limit = 2
    const f = fakeHost()
    const lc = new BrowserLifecycle({ host: f.host, maxLive: () => limit, discardMs: 5 * MIN, driven: () => false })
    await lc.attach('a', 'w'); await lc.attach('b', 'w')
    expect(await lc.attach('c', 'w')).toEqual({ ok: false, blocked: 'max_live' }) // both visible: nothing to evict
    limit = 3
    expect((await lc.attach('c', 'w')).ok).toBe(true)
    limit = 1 // below the 3 active now
    lc.setVisible('a', false); lc.setVisible('b', false) // c stays visible
    expect((await lc.attach('d', 'w')).ok).toBe(false) // evicts a and b, then c is visible: no slot
    expect(f.host.discard).toHaveBeenCalledTimes(2)
    expect(f.host.discard).not.toHaveBeenCalledWith('c')
    expect(lc.tier('c')).toBe('live')
  })
})
