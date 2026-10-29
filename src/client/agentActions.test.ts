import { describe, expect, it } from 'vitest'
import {
  CTRL_C_GAP_MS,
  EXIT_KEY_GAP_MS,
  exitDurationMs,
  exitSequence,
  exitWrites,
  ineligibleHint,
  restartEligibility,
  sendExitSequence,
} from './agentActions'
import { BUILTIN_AGENT_IDS, setCustomAgentBaseResolver } from '../shared/workspace'

const CTRL_C = '\x03'
const KILL_LINE = '\x15'
const SID = 'd3f0a1b2-0000-4000-8000-000000000000'

describe('exitSequence', () => {
  it('matches the nodeterm table', () => {
    expect(exitSequence('claude')).toBe('/exit')
    expect(exitSequence('copilot')).toBe('/exit')
    expect(exitSequence('opencode')).toBe('/exit')
    expect(exitSequence('codex')).toBe('/quit')
    expect(exitSequence('grok')).toBe('/quit')
    expect(exitSequence('gemini')).toBe('/quit')
    expect(exitSequence('cursor')).toBe('/quit')
  })
  it('has no sequence for antigravity, an unknown agent or none', () => {
    // antigravity memang tidak ada di EXIT_SEQUENCES nodeterm — ia tidak bisa restart in-place.
    expect(exitSequence('antigravity')).toBeNull()
    expect(exitSequence('custom')).toBeNull()
    expect(exitSequence(undefined)).toBeNull()
  })
  it('never carries an argument (gemini /quit --delete wipes the history)', () => {
    for (const id of BUILTIN_AGENT_IDS) expect(exitSequence(id) ?? '').not.toContain(' ')
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
  it('quits codex, opencode and copilot with two Ctrl-Cs', () => {
    for (const id of ['codex', 'opencode', 'copilot']) {
      expect(exitWrites(id)!.map((x) => x.data)).toEqual([CTRL_C, CTRL_C])
    }
  })
  it('quits grok with three Ctrl-Cs', () => {
    expect(exitWrites('grok')!).toHaveLength(3)
  })
  it('clears the line then sends gemini /quit with its CR in one write', () => {
    expect(exitWrites('gemini')!).toEqual([
      { data: KILL_LINE, gapAfterMs: EXIT_KEY_GAP_MS },
      { data: '/quit\r', gapAfterMs: 0 },
    ])
  })
  it('splits the CR off for cursor, which submits separately', () => {
    expect(exitWrites('cursor')!).toEqual([
      { data: KILL_LINE, gapAfterMs: EXIT_KEY_GAP_MS },
      { data: '/quit', gapAfterMs: EXIT_KEY_GAP_MS },
      { data: '\r', gapAfterMs: 0 },
    ])
  })
  it('never sends Escape, which a live agent reads as interrupt', () => {
    for (const id of BUILTIN_AGENT_IDS) {
      for (const w of exitWrites(id) ?? []) expect(w.data).not.toContain('\x1b')
    }
  })
  it('refuses an agent with no exit sequence', () => {
    expect(exitWrites('antigravity')).toBeNull()
    expect(exitWrites(undefined)).toBeNull()
  })
})

describe('exitDurationMs', () => {
  it('sums the gaps between writes', () => {
    expect(exitDurationMs(exitWrites('claude')!)).toBe(2 * CTRL_C_GAP_MS)
    expect(exitDurationMs(exitWrites('gemini')!)).toBe(EXIT_KEY_GAP_MS)
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
  it('reports not-resumable for a plain shell, antigravity or a baseless custom agent', () => {
    expect(restartEligibility(undefined, 'done', SID)).toEqual({ ok: false, reason: 'not-resumable' })
    expect(restartEligibility('antigravity', 'done', SID)).toEqual({ ok: false, reason: 'not-resumable' })
    expect(restartEligibility('custom', 'done', SID)).toEqual({ ok: false, reason: 'not-resumable' })
  })
  it('lets not-resumable win over working and no-session', () => {
    expect(restartEligibility('antigravity', 'working', undefined)).toEqual({
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
    await sendExitSequence('cursor', (d) => log.push(JSON.stringify(d)), async (ms) => {
      log.push(`sleep:${ms}`)
    })
    expect(log).toEqual([
      JSON.stringify(KILL_LINE),
      `sleep:${EXIT_KEY_GAP_MS}`,
      '"/quit"',
      `sleep:${EXIT_KEY_GAP_MS}`,
      JSON.stringify('\r'),
    ])
  })
  it('throws with the agent named rather than silently writing nothing', async () => {
    await expect(sendExitSequence('antigravity', () => {}, async () => {})).rejects.toThrow(/antigravity/)
  })
})
