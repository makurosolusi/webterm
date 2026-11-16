import { describe, expect, it } from 'vitest'
import {
  CTRL_C_GAP_MS,
  EXIT_SETTLE_MS,
  exitDurationMs,
  exitSequence,
  exitWrites,
  ineligibleHint,
  restartEligibility,
  sendExitSequence,
  type IneligibleReason,
} from './agentActions'
import { BUILTIN_AGENT_IDS, setCustomAgentBaseResolver } from '../shared/workspace'

const CTRL_C = '\x03'
const SESSION = '5b8e2c14-7a90-4f3d-9c61-0e2d4a7b13aa'

/** Run `fn` with `custom:<name>` resolving to `base`, always restoring the resolver. */
async function withCustomAgent<T>(name: string, base: string, fn: () => T | Promise<T>): Promise<T> {
  setCustomAgentBaseResolver((id) => (id === `custom:${name}` ? base : undefined))
  try {
    return await fn()
  } finally {
    setCustomAgentBaseResolver(null)
  }
}

describe('exit command per agent', () => {
  it('uses the documented /exit for claude', () => {
    expect(exitSequence('claude')).toBe('/exit')
  })

  it.each(['codex', 'gemini', 'opencode', 'grok', 'copilot', 'cursor', 'antigravity'])(
    'has none for the non-claude harness %s',
    (id) => expect(exitSequence(id)).toBeNull(),
  )

  it('has none for an unknown or missing agent', () => {
    expect(exitSequence('custom')).toBeNull()
    expect(exitSequence(undefined)).toBeNull()
  })

  it('follows a custom agent to its base harness', async () => {
    await withCustomAgent('wrapper', 'claude', () => expect(exitSequence('custom:wrapper')).toBe('/exit'))
    await withCustomAgent('wrapper', 'codex', () => expect(exitSequence('custom:wrapper')).toBeNull())
  })
})

describe('exit writes', () => {
  it('asks claude to quit with Ctrl+C presses: at least the documented two, plus a margin', () => {
    const writes = exitWrites('claude')!
    expect(writes.length).toBeGreaterThanOrEqual(2)
    expect(writes.every((w) => w.data === CTRL_C)).toBe(true)
  })

  it('separates presses by the gap and does not wait after the last one', () => {
    const gaps = exitWrites('claude')!.map((w) => w.gapAfterMs)
    expect(gaps.at(-1)).toBe(0)
    expect(gaps.slice(0, -1).every((g) => g === CTRL_C_GAP_MS)).toBe(true)
  })

  it('keeps each press apart by more than a double-click burst', () => {
    expect(CTRL_C_GAP_MS).toBeGreaterThanOrEqual(100)
    expect(CTRL_C_GAP_MS).toBeLessThan(800) // inside Claude Code's documented Ctrl+D confirm window
  })

  it('sends no Escape, Enter or kill-line for any builtin', () => {
    for (const id of BUILTIN_AGENT_IDS) {
      for (const w of exitWrites(id) ?? []) {
        expect(w.data).not.toMatch(/[\x1b\r\n\x15]/)
      }
    }
  })

  it('returns null for agents that cannot be asked to quit', () => {
    expect(exitWrites('gemini')).toBeNull()
    expect(exitWrites('custom')).toBeNull()
    expect(exitWrites(undefined)).toBeNull()
  })

  it('totals the gaps and leaves room in the settle window', () => {
    const writes = exitWrites('claude')!
    expect(exitDurationMs(writes)).toBe((writes.length - 1) * CTRL_C_GAP_MS)
    expect(exitDurationMs([])).toBe(0)
    expect(exitDurationMs(writes)).toBeLessThan(EXIT_SETTLE_MS)
  })
})

describe('restart eligibility', () => {
  it.each(['done', 'waiting', undefined] as const)('accepts an idle claude (%s) with a session id', (state) => {
    expect(restartEligibility('claude', state, SESSION)).toEqual({ ok: true })
  })

  it.each(['working', 'blocked'] as const)('refuses a %s session as busy', (state) => {
    // `blocked` is a dialog holding the prompt: the exit keys would answer it.
    expect(restartEligibility('claude', state, SESSION)).toEqual({ ok: false, reason: 'working' })
  })

  it.each([undefined, '', '--flag', 'a b', '$(id)'])('refuses session id %j', (sessionId) => {
    expect(restartEligibility('claude', 'done', sessionId)).toEqual({ ok: false, reason: 'no-session' })
  })

  it('reports not-resumable for a plain terminal, another harness and a baseless custom agent', () => {
    for (const id of [undefined, 'gemini', 'custom']) {
      expect(restartEligibility(id, 'done', SESSION)).toEqual({ ok: false, reason: 'not-resumable' })
    }
  })

  it('ranks not-resumable above busy and missing-session', () => {
    expect(restartEligibility('gemini', 'working', undefined)).toEqual({ ok: false, reason: 'not-resumable' })
  })

  it('lets a custom agent on claude restart', async () => {
    await withCustomAgent('wrapper', 'claude', () =>
      expect(restartEligibility('custom:wrapper', 'done', SESSION)).toEqual({ ok: true }),
    )
  })
})

describe('ineligible hints', () => {
  it('gives each reason its own readable sentence', () => {
    const reasons: IneligibleReason[] = ['working', 'no-session', 'not-resumable']
    const hints = reasons.map(ineligibleHint)
    expect(new Set(hints).size).toBe(reasons.length)
    for (const hint of hints) expect(hint.length).toBeGreaterThan(10)
  })
})

describe('sendExitSequence', () => {
  it('writes the presses in order, sleeping the declared gaps in between', async () => {
    const events: string[] = []
    await sendExitSequence(
      'claude',
      (d) => events.push(d === CTRL_C ? 'ctrl-c' : 'other'),
      async (ms) => {
        events.push(`wait:${ms}`)
      },
    )
    const presses = exitWrites('claude')!.length
    const expected = Array.from({ length: presses }, (_, i) =>
      i < presses - 1 ? ['ctrl-c', `wait:${CTRL_C_GAP_MS}`] : ['ctrl-c'],
    ).flat()
    expect(events).toEqual(expected)
  })

  it('uses the real timer by default and resolves', async () => {
    const written: string[] = []
    // A one-press agent does not exist, so just prove the default sleeper is callable end to end.
    await sendExitSequence('claude', (d) => written.push(d))
    expect(written).toHaveLength(exitWrites('claude')!.length)
  })

  it('throws naming the agent when it cannot be asked to quit, writing nothing', async () => {
    const written: string[] = []
    await expect(sendExitSequence('gemini', (d) => written.push(d), async () => {})).rejects.toThrow(/gemini/)
    await expect(sendExitSequence(undefined, () => {}, async () => {})).rejects.toThrow(/\(none\)/)
    expect(written).toEqual([])
  })
})
