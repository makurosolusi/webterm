import { afterEach, describe, expect, it } from 'vitest'
import type { ShieldPolicy } from './adblock.shields'
import { shieldExempt } from './adblock.exempt'
import { CDP, CDP_EVENT } from './cdp.client'
import { makeHostRig, stubGuard, waitFor } from './fakeCdp.testkit'

const G = 'https://www.google.com/search?q=detik'

describe('shieldExempt', () => {
  const cases: Array<[string, string, string, boolean]> = [
    ['google beacon on a google page', 'https://www.google.com/gen_204?atyp=i', G, true],
    ['google client_204 on a regional google page', 'https://www.google.co.id/client_204?&atyp=i', 'https://www.google.co.id/search?q=x', true],
    ['google /log xhr', 'https://www.google.com/log?format=json', G, true],
    ['gstatic script on a google page', 'https://www.gstatic.com/og/_/js/k=x.js', G, true],
    ['recaptcha script on any page', 'https://www.google.com/recaptcha/api.js', 'https://shop.example/login', true],
    ['recaptcha.net', 'https://www.recaptcha.net/recaptcha/api.js', 'https://shop.example/login', true],
    ['hcaptcha widget', 'https://newassets.hcaptcha.com/captcha/v1/x/hcaptcha.js', 'https://shop.example/', true],
    ['cloudflare turnstile', 'https://challenges.cloudflare.com/turnstile/v0/api.js', 'https://shop.example/', true],
    ['third-party tracker on a google page stays filtered', 'https://ads.tracker.example/p.gif', G, false],
    ['google analytics on a third-party page stays filtered', 'https://www.google-analytics.com/analytics.js', 'https://news.example/', false],
    ['gen_204 requested by a non-google page stays filtered', 'https://www.google.com/gen_204?x', 'https://news.example/', false],
    ['lookalike host is not google', 'https://evilgoogle.com/gen_204', G, false],
    ['lookalike page is not google', 'https://www.google.com/gen_204', 'https://google.com.evil.example/', false],
    ['garbage url', 'not a url', G, false],
  ]
  it.each(cases)('%s', (_n, url, page, want) => { expect(shieldExempt(url, page)).toBe(want) })
})

describe('Shields on a google page', () => {
  let rig: Awaited<ReturnType<typeof makeHostRig>>
  afterEach(async () => { await rig?.stop() })
  const callsOf = (m: string) => rig.fake.calls.filter((c) => c.method === m)

  it('lets google beacons and recaptcha through even when the filter list would block them; third parties still blocked', async () => {
    const blockAll: ShieldPolicy = { check: () => ({ block: true }), isOff: () => false, setOff: () => undefined }
    rig = await makeHostRig(stubGuard(), { shields: blockAll })
    await rig.host.open('n1', 'w1', G)
    const paused = (id: string, url: string, type: string) => rig.fake.emit(CDP_EVENT.requestPaused, { requestId: id, request: { url }, resourceType: type, frameId: 'F' }, 'S-T1')
    paused('r1', 'https://www.google.com/gen_204?atyp=i', 'Ping')
    paused('r2', 'https://www.google.com/recaptcha/api2/anchor', 'Script')
    paused('r3', 'https://ads.tracker.example/p.js', 'Script')
    await waitFor(() => callsOf(CDP.continueRequest).length === 2 && callsOf(CDP.failRequest).length === 1, 'two continued, one blocked')
    expect(rig.host.state('n1')?.blockedAds).toBe(1)
  })
})
