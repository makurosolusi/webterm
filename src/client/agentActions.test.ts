import { describe, expect, it } from 'vitest'
import {
  CTRL_C_GAP_MS,
  exitDurationMs,
  exitSequence,
  exitWrites,
  ineligibleHint,
  restartEligibility,
  sendExitSequence,
} from './agentActions'
import { BUILTIN_AGENT_IDS, setCustomAgentBaseResolver } from '../shared/workspace'

const CTRL_C = '\x03'
const SID = 'd3f0a1b2-0000-4000-8000-000000000000'

describe('exitSequence', () => {
  it('matches the expected table for claude', () => {
    expect(exitSequence('claude')).toBe('/exit')
  })
  it('has no sequence for a retired builtin (a plain terminal program now), an unknown agent or none', () => {
    for (const id of ['codex', 'gemini', 'opencode', 'grok', 'copilot', 'cursor', 'antigravity']) expect(exitSequence(id)).toBeNull()
    expect(exitSequence('custom')).toBeNull()
    expect(exitSequence(undefined)).toBeNull()
  })
  it('resolves a custom agent through its base harness', () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:wrap' ? 'claude' : undefined))
    try {
      expect(exitSequence('custom:wrap')).toBe('/exit')
    } finally {
      setCustomAgentBaseResolver(null)
    }
  })
})

describe('exitWrites', () => {
  it('quits claude with three spaced Ctrl-Cs and no kill-line', () => {
    const w = exitWrites('claude')!
    expect(w.map((x) => x.data)).toEqual([CTRL_C, CTRL_C, CTRL_C])
    expect(w.map((x) => x.gapAfterMs)).toEqual([CTRL_C_GAP_MS, CTRL_C_GAP_MS, 0])
  })
  it('never sends Escape, which a live agent reads as interrupt', () => {
    for (const id of BUILTIN_AGENT_IDS) {
      for (const w of exitWrites(id) ?? []) expect(w.data).not.toContain('\x1b')
    }
  })
  it('refuses an agent with no exit sequence', () => {
    expect(exitWrites('codex')).toBeNull()
    expect(exitWrites(undefined)).toBeNull()
  })
})

describe('exitDurationMs', () => {
  it('sums the gaps between writes', () => {
    expect(exitDurationMs(exitWrites('claude')!)).toBe(2 * CTRL_C_GAP_MS)
  })
})

describe('restartEligibility', () => {
  it('accepts an idle resumable agent with a session id', () => {
    expect(restartEligibility('claude', 'done', SID)).toEqual({ ok: true })
    expect(restartEligibility('claude', 'waiting', SID)).toEqual({ ok: true })
    expect(restartEligibility('claude', undefined, SID)).toEqual({ ok: true })
  })
  it('refuses a working session', () => {
    expect(restartEligibility('claude', 'working', SID)).toEqual({ ok: false, reason: 'working' })
  })
  it('refuses a blocked session — its exit line would answer the permission dialog', () => {
    expect(restartEligibility('claude', 'blocked', SID)).toEqual({ ok: false, reason: 'working' })
  })
  it('refuses when there is no session id, or an unsafe one', () => {
    expect(restartEligibility('claude', 'done', undefined)).toEqual({ ok: false, reason: 'no-session' })
    expect(restartEligibility('claude', 'done', '')).toEqual({ ok: false, reason: 'no-session' })
    expect(restartEligibility('claude', 'done', '-x; rm -rf /')).toEqual({ ok: false, reason: 'no-session' })
  })
  it('reports not-resumable for a plain shell, a retired builtin or a baseless custom agent', () => {
    expect(restartEligibility(undefined, 'done', SID)).toEqual({ ok: false, reason: 'not-resumable' })
    expect(restartEligibility('codex', 'done', SID)).toEqual({ ok: false, reason: 'not-resumable' })
    expect(restartEligibility('custom', 'done', SID)).toEqual({ ok: false, reason: 'not-resumable' })
  })
  it('lets not-resumable win over working and no-session', () => {
    expect(restartEligibility('codex', 'working', undefined)).toEqual({
      ok: false,
      reason: 'not-resumable',
    })
  })
})

describe('ineligibleHint', () => {
  it('says something non-empty and distinct for every reason', () => {
    const hints = (['working', 'no-session', 'not-resumable'] as const).map(ineligibleHint)
    for (const h of hints) expect(h.length).toBeGreaterThan(10)
    expect(new Set(hints).size).toBe(3)
  })
})

describe('sendExitSequence', () => {
  it('writes every byte in order and sleeps the declared gaps', async () => {
    const log: string[] = []
    await sendExitSequence('claude', (d) => log.push(JSON.stringify(d)), async (ms) => {
      log.push(`sleep:${ms}`)
    })
    expect(log).toEqual([
      JSON.stringify(CTRL_C),
      `sleep:${CTRL_C_GAP_MS}`,
      JSON.stringify(CTRL_C),
      `sleep:${CTRL_C_GAP_MS}`,
      JSON.stringify(CTRL_C),
    ])
  })
  it('throws with the agent named rather than silently writing nothing', async () => {
    await expect(sendExitSequence('codex', () => {}, async () => {})).rejects.toThrow(/codex/)
  })
})
