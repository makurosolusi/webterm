import { beforeEach, describe, expect, it } from 'vitest'
import { configureLogging, setLogLevel } from '../logs'
import type { BotCall } from './botManager'
import { PollApiError } from './telegramPollApi'
import { STATUS_CARD_DEBOUNCE_MS, createStatusCards, renderStatusCard, type StatusSnapshot } from './statusCard'

beforeEach(() => { configureLogging({ env: { WEBTERM_LOG_FILE: 'off' }, console: false }); setLogLevel('error') })

const target = { accountId: 'ops', chatId: '-1001', projectId: 'p1', threadId: 9 }
function setup(onCall?: (method: string) => void) {
  const snap: StatusSnapshot = { level: 'propose', activeWorkers: 1, budgetUsedTokens: 100_000, budgetLimitTokens: 1_000_000 }
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const timers: Array<() => void> = []
  const clock = { t: 1_000 }
  const call: BotCall = async (_a, method, params) => {
    calls.push({ method, params })
    onCall?.(method)
    return method === 'sendMessage' ? { message_id: 5 } : true
  }
  const cards = createStatusCards({ call, provider: () => ({ ...snap }), now: () => clock.t, schedule: (fn) => { timers.push(fn) } })
  return { cards, calls, timers, clock, snap }
}

describe('status card', () => {
  it('renders level, workers and budget compactly', () => {
    expect(renderStatusCard({ level: 'act_gated', activeWorkers: 2, budgetUsedTokens: 250_000, budgetLimitTokens: 1_000_000 }))
      .toBe('Central level: act_gated\nActive workers: 2\nBudget: 250000/1000000 tokens (25%)')
    expect(renderStatusCard({ level: 'off', activeWorkers: 0, budgetUsedTokens: 0, budgetLimitTokens: 0 })).toContain('(n/a)')
  })

  it('sends once into the topic, then edits; identical content makes no API call (idempotent)', async () => {
    const { cards, calls, snap, clock } = setup()
    expect(await cards.refresh(target)).toBe('sent')
    expect(calls[0]).toMatchObject({ method: 'sendMessage', params: { chat_id: '-1001', message_thread_id: 9 } })
    expect(await cards.refresh(target)).toBe('unchanged')
    expect(await cards.refresh(target)).toBe('unchanged')
    expect(calls).toHaveLength(1)
    snap.activeWorkers = 3
    clock.t += STATUS_CARD_DEBOUNCE_MS
    expect(await cards.refresh(target)).toBe('edited')
    expect(calls[1]).toMatchObject({ method: 'editMessageText', params: { chat_id: '-1001', message_id: 5 } })
    expect(String(calls[1]?.params['text'])).toContain('Active workers: 3')
  })

  it('debounces: a change inside the window is deferred to one trailing edit with the newest data', async () => {
    const { cards, calls, timers, snap, clock } = setup()
    await cards.refresh(target)
    snap.activeWorkers = 2
    expect(await cards.refresh(target)).toBe('deferred')
    snap.activeWorkers = 4
    expect(await cards.refresh(target)).toBe('deferred')
    expect(timers).toHaveLength(1)
    clock.t += STATUS_CARD_DEBOUNCE_MS
    timers[0]?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'editMessageText'])
    expect(String(calls[1]?.params['text'])).toContain('Active workers: 4')
  })

  it('concurrent first refreshes send a single message', async () => {
    const { cards, calls } = setup()
    const out = await Promise.all([cards.refresh(target), cards.refresh(target)])
    expect(out).toEqual(['sent', 'unchanged'])
    expect(calls).toHaveLength(1)
  })

  it('treats "message is not modified" as unchanged and re-posts after the card was deleted', async () => {
    let mode: 'ok' | 'same' | 'gone' = 'ok'
    const calls: string[] = []
    const call: BotCall = async (_a, method) => {
      calls.push(method)
      if (method === 'sendMessage') return { message_id: calls.length }
      if (mode === 'same') throw new PollApiError('transient', 'telegram editMessageText failed: http 400 Bad Request: message is not modified')
      if (mode === 'gone') throw new PollApiError('transient', 'telegram editMessageText failed: http 400 Bad Request: message to edit not found')
      return true
    }
    const snap = { level: 'observe', activeWorkers: 0, budgetUsedTokens: 0, budgetLimitTokens: 10 } as StatusSnapshot
    const clock = { t: 0 }
    const cards = createStatusCards({ call, provider: () => ({ ...snap }), now: () => clock.t })
    await cards.refresh(target)
    clock.t += STATUS_CARD_DEBOUNCE_MS; snap.activeWorkers = 1; mode = 'same'
    expect(await cards.refresh(target)).toBe('unchanged')
    clock.t += STATUS_CARD_DEBOUNCE_MS; snap.activeWorkers = 2; mode = 'gone'
    expect(await cards.refresh(target)).toBe('failed')
    mode = 'ok'
    expect(await cards.refresh(target)).toBe('sent')
  })
})
