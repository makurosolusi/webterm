import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserState } from '../../shared/browser.contract'
import { createChallengeTracker } from './browserHost.challenge'
import { CDP_EVENT } from './cdp.client'
import { makeHostRig, stubGuard, waitFor } from './fakeCdp.testkit'

const SORRY = 'https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Ddetik'
const RESULTS = 'https://www.google.com/search?q=detik'
const base: BrowserState = { id: 'n1', url: RESULTS, title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' }

describe('challenge tracker', () => {
  it('flags a challenge page, keeps the same object while it stays, and clears it when the page is ordinary', () => {
    const t = createChallengeTracker()
    const first = t.apply(base, { url: SORRY })
    expect(first.challenge).toEqual({ kind: 'google_unusual_traffic', url: 'https://www.google.com/sorry/index' })
    const cur = { ...base, url: SORRY, ...first }
    expect(t.apply(cur, { title: 'x' }).challenge).toBe(cur.challenge) // same reference: no spurious state emit
    expect(t.apply(cur, { url: RESULTS }).challenge).toBeUndefined()
  })

  it('leaves the part untouched when neither url nor title moved', () => {
    expect(createChallengeTracker().apply(base, { loading: true })).toEqual({ loading: true })
  })

  it('"I\'m done" hides this page until the node leaves it, then a new challenge shows again', () => {
    const t = createChallengeTracker()
    const cur = { ...base, url: SORRY, challenge: t.apply(base, { url: SORRY }).challenge }
    expect(t.dismiss(cur)).toEqual({ challenge: undefined })
    const dismissed = { ...cur, challenge: undefined }
    expect(t.apply(dismissed, { title: 'again' }).challenge).toBeUndefined() // same page, still dismissed
    t.apply(dismissed, { url: RESULTS })
    expect(t.apply({ ...dismissed, url: RESULTS }, { url: SORRY }).challenge?.kind).toBe('google_unusual_traffic')
  })

  it('dismiss with nothing shown is a no-op', () => {
    expect(createChallengeTracker().dismiss(base)).toBeNull()
  })
})

describe('BrowserHost challenge state', () => {
  let rig: Awaited<ReturnType<typeof makeHostRig>>
  afterEach(async () => { await rig?.stop() })

  it('sets state.challenge on the sorry page and clears it after "I\'m done" (agents are then free again)', async () => {
    rig = await makeHostRig(stubGuard())
    await rig.host.open('n1', 'w1', RESULTS)
    const state = () => rig.host.state('n1') as BrowserState
    expect(state().challenge).toBeUndefined()
    rig.fake.emit(CDP_EVENT.frameNavigated, { frame: { id: 'T1', url: SORRY } }, 'S-T1')
    await waitFor(() => state().challenge?.kind === 'google_unusual_traffic', 'challenge shown')
    expect(state().challenge?.url).toBe('https://www.google.com/sorry/index') // query (the search terms) is never kept
    rig.host.dismissChallenge('n1')
    expect(state().challenge).toBeUndefined()
  })
})
