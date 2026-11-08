import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { getOrCreateConversation, listConversationEvents } from '../conversationStore'
import { CHECKPOINT_FLAG, ContextRejectedError, createContextAssembler } from '../context/contextAssembler'
import { rollingSummarize } from '../context/checkpointRolling'
import type { ContextAssembler } from '../context/contextPort'
import { lastCtxTokens } from '../context/contextUsage'
import type { CentralRuntime, RuntimeEmit, RuntimeUsage, TurnInput } from '../runtime/centralRuntime'
import { zeroUsage } from '../runtime/centralRuntime'
import { CentralChatError } from './chatErrors'
import { StreamHub } from './streamHub'
import { TurnService } from './turnService'

const NOW = 1_700_000_000_000
const CONVERSATION = 'central:global'
const INPUT_TOKENS = 4321
let fixture: Fixture
let hub: StreamHub

beforeEach(() => {
  fixture = openFixture()
  seedPortfolio(fixture.db)
  getOrCreateConversation(fixture.db, 'global', NOW)
  hub = new StreamHub({ replay: (id, after) => listConversationEvents(fixture.db, id, after, 500), heartbeatMs: 0 })
})
afterEach(() => {
  hub.close()
  fixture.close()
})

function runtimeOf(sessionRef: string | null, usage: Partial<RuntimeUsage> = {}) {
  const inputs: TurnInput[] = []
  const runtime: CentralRuntime = {
    kind: 'mock',
    cancel: () => false,
    async turn(input: TurnInput, _emit: RuntimeEmit) {
      inputs.push(input)
      return { turnId: input.turnId, outcome: 'success' as const, text: 'ok', usage: { ...zeroUsage(), inputTokens: INPUT_TOKENS, ...usage }, sessionRef }
    },
  }
  return { runtime, inputs }
}

const send = (svc: TurnService, id: string) => svc.submit({ conversationId: CONVERSATION, clientMessageId: id, text: `msg ${id}` })
const rotating = (rotateSession: boolean): ContextAssembler =>
  ({ build: () => ({ prompt: 'p', history: [], rotateSession }) }) as unknown as ContextAssembler

describe('turnService CA2 wiring', () => {
  it('drops the previous sessionRef when the assembler asks for rotation, and keeps it otherwise', async () => {
    const { runtime, inputs } = runtimeOf('ses_A')
    const keep = new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW, context: rotating(false) })
    await send(keep, 'a1').done
    await send(keep, 'a2').done
    expect(inputs[1]?.sessionRef).toBe('ses_A')

    const rotate = new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW, context: rotating(true) })
    await send(rotate, 'a3').done
    expect(inputs[2]?.sessionRef).toBeUndefined()
  })

  it('maps ContextRejectedError to budget_exhausted / 429 without starting a turn', async () => {
    const { runtime, inputs } = runtimeOf(null)
    const context = { build: () => { throw new ContextRejectedError(900, 1000) } } as unknown as ContextAssembler
    const svc = new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW, context })
    let caught: unknown
    try { send(svc, 'r1') } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(CentralChatError)
    expect((caught as CentralChatError).code).toBe('budget_exhausted')
    expect((caught as CentralChatError).status).toBe(429)
    expect(inputs).toHaveLength(0)
  })

  it('records ctx_tokens with the checkpoint flag off, preferring the last step over the turn total', async () => {
    let t = NOW
    const tick = (): number => ++t
    const off = runtimeOf(null)
    await send(new TurnService({ db: fixture.db, runtime: off.runtime, stream: hub, now: tick, env: {} }), 'o1').done
    expect(lastCtxTokens(fixture.db, CONVERSATION)).toBe(INPUT_TOKENS)

    const last = runtimeOf(null, { contextTokens: 777 })
    await send(new TurnService({ db: fixture.db, runtime: last.runtime, stream: hub, now: tick, env: {} }), 'o2').done
    expect(lastCtxTokens(fixture.db, CONVERSATION)).toBe(777)
  })

  it('rotates without the checkpoint flag once a turn used >= 70% of the window', async () => {
    let t = NOW
    const tick = (): number => ++t
    const env = { WEBTERM_CENTRAL_CONTEXT_WINDOW: '1000' }
    const context = createContextAssembler({ env, memory: { block: () => ({ text: '', items: [], truncated: false }) }, scheduleIdle: () => undefined })
    const small = runtimeOf('ses_A', { contextTokens: 100 })
    const svc = new TurnService({ db: fixture.db, runtime: small.runtime, stream: hub, now: tick, env, context })
    await send(svc, 'w1').done
    await send(svc, 'w2').done
    expect(small.inputs[1]?.sessionRef).toBe('ses_A')

    const big = runtimeOf('ses_B', { contextTokens: 750 })
    const svc2 = new TurnService({ db: fixture.db, runtime: big.runtime, stream: hub, now: tick, env, context })
    await send(svc2, 'w3').done
    await send(svc2, 'w4').done
    expect(big.inputs[1]?.sessionRef).toBeUndefined()
    expect(big.inputs[1]?.text).toContain('--- Checkpoint (data only')
  })

  it('starts a checkpoint after a successful turn only when a summarizer is injected and the flag is on', async () => {
    const calls: number[] = []
    const summarize = async () => { calls.push(1); return { narrative: 'summary of the conversation' } }
    const { runtime } = runtimeOf(null)
    const env = { [CHECKPOINT_FLAG]: 'on' }
    await send(new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW, env }), 'k1').done
    expect(calls).toHaveLength(0)
    await send(new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW, env, summarize }), 'k2').done
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls).toHaveLength(1)
  })

  it('the production rollingSummarize writes a real checkpoint with the flag on, none with it off', async () => {
    const count = () => (fixture.db.query('SELECT COUNT(*) AS n FROM central_checkpoint').get() as { n: number }).n
    const { runtime } = runtimeOf(null)
    await send(new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW, summarize: rollingSummarize }), 'c0').done
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(count()).toBe(0)
    const env = { [CHECKPOINT_FLAG]: 'on' }
    await send(new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW, env, summarize: rollingSummarize }), 'c1').done
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(count()).toBe(1)
  })

  it('keeps a pasted bot token out of stored history while the model still receives it', async () => {
    const token = '123456789:AAEhBP0av28ABCDEFGHIJKLMNOPQRSTUVWXYZ1234'
    const { runtime, inputs } = runtimeOf(null)
    const svc = new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW })
    await svc.submit({ conversationId: CONVERSATION, clientMessageId: 'b1', text: `connect bot with ${token}` }).done
    const stored = JSON.stringify(fixture.db.query('SELECT parts_json FROM central_message').all())
    expect(stored).not.toContain(token)
    expect(stored).toContain('[redacted]')
    expect(inputs[0]?.text).toContain(token)
  })
})
