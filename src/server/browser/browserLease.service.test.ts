import { describe, expect, it, vi } from 'vitest'
import { HUMAN_IDLE_MS, LEASE_TTL_MS } from '../../shared/browser.contract'
import { HUMAN_WAIT_MAX_MS, LeaseService } from './browserLease.service'

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

  it('acquire takes a fresh node at once and emits agent; a later acquire extends the ttl', async () => {
    const { svc, advance } = setup()
    const seen: string[] = []
    svc.onChange((id, l) => seen.push(`${id}:${l}`))
    const sleep = vi.fn(async () => undefined)
    expect(await svc.acquire('n1', true, sleep)).toEqual({ lease: 'agent', ttlMs: LEASE_TTL_MS })
    expect(sleep).not.toHaveBeenCalled()
    expect(seen).toEqual(['n1:agent'])
    advance(LEASE_TTL_MS - 1)
    await svc.acquire('n1', true, sleep)
    advance(LEASE_TTL_MS - 1)
    expect(svc.holder('n1')).toBe('agent')
    expect(seen).toEqual(['n1:agent'])
  })

  it('acquire with agent control off is disabled and takes no lease', async () => {
    const { svc } = setup()
    await expect(svc.acquire('n1', false, async () => undefined)).rejects.toMatchObject({ code: 'disabled' })
    expect(svc.holder('n1')).toBe('human')
  })

  it('acquire waits out recent human input, then proceeds', async () => {
    const { svc, advance } = setup()
    svc.noteHumanInput('n1')
    advance(1_000)
    const waits: number[] = []
    await svc.acquire('n1', true, async (ms) => { waits.push(ms); advance(ms) })
    expect(waits).toEqual([HUMAN_IDLE_MS - 1_000])
    expect(svc.holder('n1')).toBe('agent')
  })

  it('acquire gives up with human_active when the human keeps going past the bound', async () => {
    const { svc, advance } = setup()
    svc.noteHumanInput('n1')
    let waited = 0
    const typing = async (ms: number) => { waited += ms; advance(ms - 1); svc.noteHumanInput('n1'); advance(1) }
    await expect(svc.acquire('n1', true, typing)).rejects.toMatchObject({ code: 'human_active' })
    expect(waited).toBeLessThanOrEqual(HUMAN_WAIT_MAX_MS)
    expect(svc.holder('n1')).toBe('human')
  })

  it('takeover holds the agent off for the idle window instead of being re-acquired at once', async () => {
    const { svc, advance } = setup()
    svc.handoff('n1', true)
    svc.takeover('n1')
    const waits: number[] = []
    await svc.acquire('n1', true, async (ms) => { waits.push(ms); advance(ms) })
    expect(waits).toEqual([HUMAN_IDLE_MS])
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
