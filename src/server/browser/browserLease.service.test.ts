import { describe, expect, it } from 'vitest'
import { HUMAN_IDLE_MS, LEASE_TTL_MS } from '../../shared/browser.contract'
import { LeaseService } from './browserLease.service'

function setup() {
  let t = 1_000_000
  const svc = new LeaseService(() => t)
  return { svc, advance: (ms: number) => { t += ms } }
}
const codeOf = (fn: () => unknown) => { try { fn() } catch (e) { return (e as { code?: string }).code } return undefined }

describe('LeaseService', () => {
  it('starts as human and refuses handoff when agent control is off', () => {
    const { svc } = setup()
    expect(svc.holder('n1')).toBe('human')
    expect(codeOf(() => svc.handoff('n1', false))).toBe('disabled')
  })

  it('hands off to the agent and reports the ttl', () => {
    const { svc } = setup()
    expect(svc.handoff('n1', true)).toEqual({ lease: 'agent', ttlMs: LEASE_TTL_MS })
    expect(svc.holder('n1')).toBe('agent')
    expect(svc.isDriven('n1')).toBe(true)
  })

  it('refuses handoff while a human typed within HUMAN_IDLE_MS, allows it after', () => {
    const { svc, advance } = setup()
    svc.noteHumanInput('n1')
    advance(HUMAN_IDLE_MS - 1)
    expect(codeOf(() => svc.handoff('n1', true))).toBe('human_active')
    advance(1)
    expect(svc.handoff('n1', true).lease).toBe('agent')
  })

  it('expires the agent lease after LEASE_TTL_MS of silence and notifies listeners', () => {
    const { svc, advance } = setup()
    const seen: string[] = []
    svc.onChange((id, lease) => seen.push(`${id}:${lease}`))
    svc.handoff('n1', true)
    advance(LEASE_TTL_MS - 1)
    expect(svc.holder('n1')).toBe('agent')
    advance(1)
    expect(svc.holder('n1')).toBe('human')
    expect(seen).toEqual(['n1:agent', 'n1:human'])
  })

  it('touch/requireAgent extend the ttl; requireAgent throws lease_human for a human lease', () => {
    const { svc, advance } = setup()
    expect(codeOf(() => svc.requireAgent('n1'))).toBe('lease_human')
    svc.handoff('n1', true)
    advance(LEASE_TTL_MS - 1)
    svc.requireAgent('n1')
    advance(LEASE_TTL_MS - 1)
    expect(svc.holder('n1')).toBe('agent')
  })

  it('takeover and release return the lease to human (idempotent)', () => {
    const { svc } = setup()
    svc.handoff('n1', true)
    svc.takeover('n1')
    expect(svc.holder('n1')).toBe('human')
    svc.release('n1')
    expect(svc.holder('n1')).toBe('human')
  })

  it('sweep lists nodes whose agent lease just expired', () => {
    const { svc, advance } = setup()
    svc.handoff('n1', true)
    svc.handoff('n2', true)
    advance(LEASE_TTL_MS)
    expect(svc.sweep().sort()).toEqual(['n1', 'n2'])
    expect(svc.sweep()).toEqual([])
  })
})
