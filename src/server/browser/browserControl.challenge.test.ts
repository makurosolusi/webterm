import { describe, expect, it, vi } from 'vitest'
import { HUMAN_VERIFICATION_CODE, HUMAN_VERIFICATION_NEXT, HUMAN_VERIFICATION_STOP_AFTER, HUMAN_VERIFICATION_STOP_NEXT } from '../../shared/browser.challenge'
import type { BrowserChallenge } from '../../shared/browser.challenge'
import type { BrowserState, BrowserVerb } from '../../shared/browser.contract'
import { allows } from '../control/capabilities'
import type { CapabilityRecord } from '../control/capabilities'
import type { AgentVerbs } from './browserAgent.verbs.ctx'
import { challengeRefusal, pauseLeaseOnChallenge } from './browserControl.challenge'
import { handleBrowserControl } from './browserControl.handler'
import { LeaseService } from './browserLease.service'

const CHECK: BrowserChallenge = { kind: 'google_unusual_traffic', url: 'https://www.google.com/sorry/index' }
const rec = (verb: string): CapabilityRecord => ({ id: 'i', verb: verb as CapabilityRecord['verb'], resource: 'node:n1', expiresAt: Number.MAX_SAFE_INTEGER })
const TOKENS: Record<string, CapabilityRecord> = { act: rec('browser.act'), read: rec('browser.read') }

function rig(challenge: { current: BrowserChallenge | undefined }) {
  const ran: string[] = []
  const verbs = new Proxy({} as AgentVerbs, { get: (_t, v: string) => async () => { ran.push(v); return { ok: true } } })
  const call = (verb: BrowserVerb, token = 'act') => handleBrowserControl(
    { method: 'POST', path: `/api/control/browser/n1/${verb}`, headers: { 'x-webterm-capability': token } },
    { capabilities: { verify: (t: string) => TOKENS[t], allows }, verbs, agentAllowed: () => true, challengeOf: () => challenge.current },
  )
  return { ran, call }
}

describe('agent verbs while the node shows a human check', () => {
  it('answers human_verification_required with the instruction, and never runs the verb', async () => {
    const r = rig({ current: CHECK })
    for (const verb of ['navigate', 'click', 'snapshot'] as const) {
      const res = await r.call(verb, verb === 'snapshot' ? 'read' : 'act')
      expect(res).toMatchObject({ status: 409, body: { error: HUMAN_VERIFICATION_CODE, kind: 'google_unusual_traffic', next: HUMAN_VERIFICATION_NEXT } })
    }
    expect(r.ran).toEqual([])
    expect(challengeRefusal('n1', 'click', undefined)).toBeNull() // clears this node's count for the next tests
  })

  it('every verb that touches the page is paused, not just navigate', () => {
    for (const verb of ['navigate', 'click', 'type', 'snapshot', 'screenshot', 'press', 'scroll', 'wait', 'console', 'tab', 'handoff'] as const) {
      expect(challengeRefusal(`pause-${verb}`, verb, CHECK), verb).toMatchObject({ status: 409 })
    }
  })

  it('status, tabs and release still work, so the agent can see the state and hand the node back', async () => {
    const r = rig({ current: CHECK })
    for (const verb of ['status', 'tabs'] as const) expect((await r.call(verb, 'read')).status).toBe(200)
    expect((await r.call('release')).status).toBe(200)
    expect(r.ran).toEqual(['status', 'tabs', 'release'])
  })

  it('after a few refusals the instruction becomes "stop calling browser verbs" (no retry loop)', async () => {
    const r = rig({ current: CHECK })
    challengeRefusal('n1', 'click', undefined)
    const nexts: unknown[] = []
    for (let i = 0; i < HUMAN_VERIFICATION_STOP_AFTER + 2; i++) nexts.push(((await r.call('navigate'))?.body as { next: string }).next)
    expect(nexts.slice(0, HUMAN_VERIFICATION_STOP_AFTER).every((n) => n === HUMAN_VERIFICATION_NEXT)).toBe(true)
    expect(nexts.slice(HUMAN_VERIFICATION_STOP_AFTER)).toEqual([HUMAN_VERIFICATION_STOP_NEXT, HUMAN_VERIFICATION_STOP_NEXT])
  })

  it('resumes once the check is gone, and the refusal count starts over for the next one', async () => {
    const check = { current: CHECK as BrowserChallenge | undefined }
    const r = rig(check)
    for (let i = 0; i < HUMAN_VERIFICATION_STOP_AFTER + 1; i++) await r.call('click')
    check.current = undefined // "I'm done" or the page moved on
    expect((await r.call('click')).status).toBe(200)
    expect(r.ran).toEqual(['click'])
    check.current = CHECK
    expect((await r.call('click'))?.body).toMatchObject({ refused: 1, next: HUMAN_VERIFICATION_NEXT })
  })

  it('a node without a check is untouched', () => {
    expect(challengeRefusal('n9', 'click', undefined)).toBeNull()
  })
})

describe('lease while a human check is shown', () => {
  it('an agent holding the lease lets go when the check appears; it can take the node again after it clears', () => {
    const leases = new LeaseService(() => 1_000_000)
    leases.handoff('n1', true)
    expect(leases.holder('n1')).toBe('agent')
    let emit: (s: BrowserState) => void = () => undefined
    pauseLeaseOnChallenge({ onState: (cb) => { emit = cb; return vi.fn() } }, leases)
    const state = { id: 'n1', url: '', title: '', loading: false, canBack: false, canForward: false, lease: 'agent', live: 'live' } as const
    emit({ ...state }) // ordinary page: nothing happens
    expect(leases.holder('n1')).toBe('agent')
    emit({ ...state, challenge: CHECK })
    expect(leases.holder('n1')).toBe('human')
    emit({ ...state })
    expect(leases.handoff('n1', true).lease).toBe('agent') // resumed: the agent may drive again
  })
})
