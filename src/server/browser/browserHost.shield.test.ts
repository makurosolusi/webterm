import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserState } from '../../shared/browser.contract'
import type { HostEvent } from './browserHost.service'
import { POPUP_BURST_MAX, POPUP_BURST_WINDOW_MS, redirectBody } from './browserHost.shield'
import type { ShieldPolicy } from './adblock.shields'
import type { AdblockVerdict } from './adblock.engine'
import { CDP, CDP_EVENT } from './cdp.client'
import { makeHostRig, stubGuard, waitFor } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })

const SID = 'S-T1'
const callsOf = (method: string) => rig.fake.calls.filter((c) => c.method === method)

/** Test-only policy: `ads.test` blocked, `redir.test` replaced by a stub script; sites can be switched off. */
function fakePolicy(): ShieldPolicy & { off: Set<string> } {
  const off = new Set<string>()
  const check = (url: string): AdblockVerdict => {
    const h = new URL(url).hostname
    if (h === 'ads.test') return { block: true }
    if (h === 'redir.test') return { block: true, redirect: { body: '(function(){})()', contentType: 'application/javascript' } }
    return { block: false }
  }
  return { off, check, isOff: (h) => off.has(h), setOff: (h, v) => { if (v) off.add(h); else off.delete(h) } }
}

async function openShielded(opts: { policy?: ShieldPolicy; now?: () => number } = {}) {
  rig = await makeHostRig(stubGuard(), { shields: 'policy' in opts ? opts.policy : fakePolicy(), now: opts.now })
  const events: HostEvent[] = []
  rig.host.onEvent((e) => events.push(e))
  await rig.host.open('n1', 'w1', 'https://games.test/')
  return { events, state: () => rig.host.state('n1') as BrowserState }
}
const popup = (id: string, url: string) => rig.fake.emit(CDP_EVENT.targetCreated, { targetInfo: { targetId: id, type: 'page', title: '', url, openerId: 'T1' } })
const paused = (requestId: string, url: string, resourceType: string, sessionId = SID, frameId = 'F-sub') =>
  rig.fake.emit(CDP_EVENT.requestPaused, { requestId, request: { url }, resourceType, frameId }, sessionId)

describe('popups', () => {
  it('a popup to a filtered ad URL is closed silently and counted; no node is opened', async () => {
    const { events, state } = await openShielded()
    popup('P1', 'https://ads.test/landing')
    await waitFor(() => state().blockedPopups === 1, 'popup counted')
    await waitFor(() => callsOf(CDP.closeTarget).length === 1, 'popup closed')
    expect(events.filter((e) => e.k === 'popup')).toEqual([])
    expect(state().url).toBe('https://games.test/')
  })

  it('caps legit popups per opener and lets them through again after the window', async () => {
    let t = 1_000_000
    const { events, state } = await openShielded({ now: () => t })
    for (let i = 0; i < POPUP_BURST_MAX + 2; i++) popup(`P${i}`, `https://news.test/${i}`)
    await waitFor(() => (state().blockedPopups ?? 0) === 2, 'flood counted')
    expect(events.filter((e) => e.k === 'popup')).toHaveLength(POPUP_BURST_MAX)
    expect(callsOf(CDP.closeTarget)).toHaveLength(POPUP_BURST_MAX + 2)
    t += POPUP_BURST_WINDOW_MS
    popup('Q1', 'https://news.test/later')
    await waitFor(() => events.filter((e) => e.k === 'popup').length === POPUP_BURST_MAX + 1, 'allowed again')
  })

  it('without an adblock policy, popups still never navigate the opener', async () => {
    const { events } = await openShielded({ policy: undefined })
    popup('P1', 'https://ads.test/landing')
    await waitFor(() => events.some((e) => e.k === 'popup'), 'popup event')
    expect(callsOf(CDP.navigate).map((c) => c.params.url)).toEqual(['https://games.test/'])
    expect(callsOf(CDP.fetchEnable)).toHaveLength(0)
  })
})

describe('request interception', () => {
  it('enables Fetch (Request stage) and iframe auto-attach on the page session', async () => {
    const { state } = await openShielded()
    expect(callsOf(CDP.fetchEnable)[0]).toMatchObject({ sessionId: SID, params: { patterns: [{ urlPattern: '*', requestStage: 'Request' }] } })
    expect(callsOf(CDP.setAutoAttach)[0]).toMatchObject({ sessionId: SID, params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } })
    expect(state()).toMatchObject({ shieldsOff: false, blockedAds: 0, blockedPopups: 0 })
  })

  it('fails ad requests with BlockedByClient, continues the rest, never blocks the main document', async () => {
    const { state } = await openShielded()
    paused('r1', 'https://ads.test/ad.js', 'Script')
    paused('r2', 'https://cdn.games.test/app.js', 'Script')
    paused('r3', 'https://ads.test/', 'Document', SID, 'T1') // dokumen utama (frameId = targetId)
    paused('r4', 'https://redir.test/lib.js', 'Script')
    await waitFor(() => callsOf(CDP.continueRequest).length === 2 && callsOf(CDP.failRequest).length === 1 && callsOf(CDP.fulfillRequest).length === 1, 'all answered')
    expect(callsOf(CDP.failRequest)[0]).toMatchObject({ sessionId: SID, params: { requestId: 'r1', errorReason: 'BlockedByClient' } })
    expect(callsOf(CDP.continueRequest).map((c) => c.params.requestId).sort()).toEqual(['r2', 'r3'])
    expect(callsOf(CDP.fulfillRequest)[0].params).toMatchObject({ requestId: 'r4', responseCode: 200, body: Buffer.from('(function(){})()').toString('base64') })
    expect(state().blockedAds).toBe(2)
  })

  it('intercepts inside auto-attached cross-site iframes and resumes them', async () => {
    const { state } = await openShielded()
    rig.fake.emit(CDP_EVENT.attachedToTarget, { sessionId: 'S-IF', targetInfo: { targetId: 'IF1', type: 'iframe', url: 'https://ads.test/frame' }, waitingForDebugger: true }, SID)
    await waitFor(() => callsOf(CDP.runIfWaiting).some((c) => c.sessionId === 'S-IF'), 'iframe resumed')
    expect(callsOf(CDP.fetchEnable).some((c) => c.sessionId === 'S-IF')).toBe(true)
    paused('r9', 'https://ads.test/x.gif', 'Image', 'S-IF')
    await waitFor(() => callsOf(CDP.failRequest).some((c) => c.sessionId === 'S-IF'), 'iframe ad blocked')
    expect(state().blockedAds).toBe(1)
  })

  it('counts reset when the main frame navigates to a new page', async () => {
    const { state } = await openShielded()
    paused('r1', 'https://ads.test/ad.js', 'Script')
    await waitFor(() => state().blockedAds === 1, 'counted')
    rig.fake.emit(CDP_EVENT.frameNavigated, { frame: { id: 'T1', url: 'https://games.test/next' } }, SID)
    await waitFor(() => state().url === 'https://games.test/next', 'navigated')
    expect(state().blockedAds).toBe(0)
  })
})

describe('per-site switch', () => {
  it('turning Shields off for the site persists via the policy, reloads, and lets ads through', async () => {
    const policy = fakePolicy()
    const { state } = await openShielded({ policy })
    await rig.host.setShields('n1', false)
    expect(policy.off.has('games.test')).toBe(true)
    expect(state().shieldsOff).toBe(true)
    expect(callsOf(CDP.reload)).toHaveLength(1)
    paused('r1', 'https://ads.test/ad.js', 'Script')
    await waitFor(() => callsOf(CDP.continueRequest).length === 1, 'continued')
    expect(callsOf(CDP.failRequest)).toHaveLength(0)
    await rig.host.setShields('n1', true)
    expect(state().shieldsOff).toBe(false)
  })
})

describe('redirectBody', () => {
  it('passes base64 resources through and encodes text ones', () => {
    expect(redirectBody({ body: 'R0lG', contentType: 'image/gif;base64' })).toEqual({ body: 'R0lG', contentType: 'image/gif' })
    expect(redirectBody({ body: 'x', contentType: 'text/plain' })).toEqual({ body: Buffer.from('x').toString('base64'), contentType: 'text/plain' })
  })
})
