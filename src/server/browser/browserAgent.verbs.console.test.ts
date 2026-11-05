import { afterEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_VERB_CAP } from '../../shared/browser.contract'
import type { BrowserHostApi } from '../../shared/browser.contract'
import type { ConsoleClientMsg, ConsoleEntry } from '../../shared/browser.console'
import { parseClientMsg } from '../../shared/browser.wire'
import { isCdpAllowed } from './browserAgent.cdpAllowlist'
import { SnapshotStore } from './browserAgent.snapshot'
import { createAgentVerbs } from './browserAgent.verbs'
import { UNTRUSTED_OPEN } from './browserAgent.wrap'
import { LeaseService } from './browserLease.service'
import { CDP } from './cdp.client'
import { makeRig, stateOf } from './browserWs.testkit'
import type { Rig } from './browserWs.testkit'
import { waitFor } from './fakeCdp.testkit'

const entry = (seq: number, level: ConsoleEntry['level'], text: string, over: Partial<ConsoleEntry> = {}): ConsoleEntry => ({ seq, ts: 0, level, source: 'console', text, ...over })
const ENTRIES = [ // test-only
  entry(1, 'verbose', 'debug noise'),
  entry(2, 'info', 'hello'),
  entry(3, 'error', 'Uncaught TypeError: boom', { source: 'exception', url: 'https://a.test/app.js', line: 12, stack: [{ fn: 'go', url: 'https://a.test/app.js', line: 12, col: 3 }] }),
]

function verbsWith(read?: (id: string, limit: number, min: string) => { entries: ConsoleEntry[]; dropped: number }, capture: (id: string) => Promise<boolean> = async () => false) {
  const host = { state: () => stateOf('n1') } as unknown as BrowserHostApi
  return createAgentVerbs({ host, leases: new LeaseService(() => 0), snapshots: new SnapshotStore(), agentAllowed: () => true, sleep: async () => undefined, now: () => 0, ...(read ? { console: { read: read as never, capture } } : {}) })
}

describe('agent console verb', () => {
  it('is a browser.read verb', () => {
    expect(BROWSER_VERB_CAP.console).toBe('browser.read')
  })

  it('returns the newest entries at or above the level as untrusted text lines', async () => {
    const read = vi.fn((_id: string, limit: number, min: string) => ({ entries: ENTRIES.filter((e) => min === 'verbose' || e.level !== 'verbose').slice(-limit), dropped: 4 }))
    const r = await verbsWith(read).console('n1', { limit: 5, level: 'info' })
    expect(read).toHaveBeenCalledWith('n1', 5, 'info')
    expect(r.count).toBe(2)
    expect(r.dropped).toBe(4)
    expect(r.content).toContain(UNTRUSTED_OPEN)
    expect(r.content).toContain('[info] hello')
    expect(r.content).toContain('[error/exception] Uncaught TypeError: boom (app.js:12)\n    at go (https://a.test/app.js:12:3)')
    expect(r.content).not.toContain('debug noise')
  })

  it('defaults to 50 entries at info level and validates the body', async () => {
    const read = vi.fn(() => ({ entries: [], dropped: 0 }))
    const verbs = verbsWith(read)
    await verbs.console('n1', {})
    expect(read).toHaveBeenCalledWith('n1', 50, 'info')
    await expect(verbs.console('n1', { limit: 0 })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(verbs.console('n1', { level: 'fatal' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(verbsWith().console('n1', {})).rejects.toMatchObject({ code: 'disabled' })
  })

  it('starts capture before reading and notes it only on the read that switched it on', async () => {
    const order: string[] = []
    let on = false
    const capture = vi.fn(async () => { order.push('capture'); const started = !on; on = true; return started })
    const verbs = verbsWith(() => { order.push('read'); return { entries: [], dropped: 0 } }, capture)
    expect((await verbs.console('n1', {})).note).toBe('Console capture started now; earlier messages were not recorded.')
    expect((await verbs.console('n1', {})).note).toBeUndefined()
    expect(order).toEqual(['capture', 'read', 'capture', 'read'])
    expect(capture).toHaveBeenCalledWith('n1')
  })

  it('does not widen the agent CDP allowlist', () => {
    for (const m of [CDP.evaluate, CDP.runtimeEnable, CDP.logEnable, CDP.releaseObjectGroup]) expect(isCdpAllowed(m, {})).toBe(false)
    expect(isCdpAllowed(CDP.evaluate, { expression: '1' })).toBe(false)
  })
})

describe('console wire message', () => {
  it('parses open/eval/clear/preserve and rejects malformed ones', () => {
    expect(parseClientMsg({ t: 'console', id: 'n1', op: 'open' })).toEqual({ t: 'console', id: 'n1', op: 'open' })
    expect(parseClientMsg({ t: 'console', id: 'n1', op: 'eval', expr: '1+1' })).toEqual({ t: 'console', id: 'n1', op: 'eval', expr: '1+1' })
    expect(parseClientMsg({ t: 'console', id: 'n1', op: 'clear' })).toEqual({ t: 'console', id: 'n1', op: 'clear' })
    expect(parseClientMsg({ t: 'console', id: 'n1', op: 'preserve', on: true })).toEqual({ t: 'console', id: 'n1', op: 'preserve', on: true })
    for (const bad of [{ op: 'eval', expr: '  ' }, { op: 'eval' }, { op: 'preserve' }, { op: 'run' }]) expect(parseClientMsg({ t: 'console', id: 'n1', ...bad })).toBeNull()
  })
})

describe('gateway console', () => {
  let rig: Rig
  afterEach(async () => { await rig?.stop() })

  async function attached() {
    rig = await makeRig()
    const commands: ConsoleClientMsg[] = []
    Object.assign(rig.host, {
      console: {
        snapshot: (id: string) => ({ id, entries: [entry(1, 'error', 'boom')], dropped: 0, preserve: false, capturing: false, reset: true }),
        command: async (m: ConsoleClientMsg) => { commands.push(m) },
        onDelta: () => () => undefined,
      },
    })
    const c = await rig.connect()
    c.send({ t: 'attach', id: 'n1', w: 800, h: 600, dpr: 1 })
    await waitFor(() => c.json.some((m) => m.t === 'console'), 'snapshot on attach')
    return { c, commands }
  }

  it('sends the buffer on attach and forwards open/clear/preserve even while an agent drives', async () => {
    const { c, commands } = await attached()
    expect(c.json.find((m) => m.t === 'console')).toMatchObject({ id: 'n1', reset: true, entries: [{ text: 'boom' }] })
    rig.leases.holders.set('n1', 'agent')
    c.send({ t: 'console', id: 'n1', op: 'open' })
    c.send({ t: 'console', id: 'n1', op: 'clear' })
    c.send({ t: 'console', id: 'n1', op: 'preserve', on: true })
    await waitFor(() => commands.length === 3, 'three commands')
    expect(commands.map((m) => m.op)).toEqual(['open', 'clear', 'preserve'])
  })

  it('gates eval exactly like user input: refused with lease_agent while the agent holds the lease', async () => {
    const { c, commands } = await attached()
    rig.leases.holders.set('n1', 'agent')
    c.send({ t: 'console', id: 'n1', op: 'eval', expr: 'document.cookie' })
    await waitFor(() => c.json.some((m) => m.t === 'error'), 'error')
    expect(c.json.find((m) => m.t === 'error')).toMatchObject({ id: 'n1', code: 'lease_agent' })
    expect(commands).toEqual([])
    rig.leases.holders.set('n1', 'human')
    c.send({ t: 'console', id: 'n1', op: 'eval', expr: '1' })
    await waitFor(() => commands.length === 1, 'eval forwarded')
    expect(rig.leases.noted).toContain('n1') // counts as human activity, like input
  })
})
