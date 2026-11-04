// The assembler's cacheEnv (1h prompt-cache TTL) rides on TurnInput to the runtime; legacy = none.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { getOrCreateConversation, listConversationEvents } from '../conversationStore'
import type { ContextAssembler } from '../context/contextPort'
import { type CentralRuntime, type TurnInput, zeroUsage } from '../runtime/centralRuntime'
import { StreamHub } from './streamHub'
import { TurnService } from './turnService'

const NOW = 1_700_000_000_000
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

function capture() {
  const inputs: TurnInput[] = []
  const runtime: CentralRuntime = {
    kind: 'mock', cancel: () => false,
    async turn(input) { inputs.push(input); return { turnId: input.turnId, outcome: 'success', text: 'ok', usage: zeroUsage(), sessionRef: null } },
  }
  return { runtime, inputs }
}

// test-only assembler: the real one's output shape, minus the rotation bookkeeping.
const assembler = (cacheEnv: Record<string, string>): ContextAssembler =>
  ({ build: ({ text }) => ({ prompt: text, history: [], cacheEnv }) as ReturnType<ContextAssembler['build']> })

const send = (svc: TurnService) => svc.submit({ conversationId: 'central:global', clientMessageId: 'c1', text: 'hi' }).done

describe('turnService threads cacheEnv into TurnInput', () => {
  it('passes the assembler cacheEnv to the runtime', async () => {
    const { runtime, inputs } = capture()
    await send(new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW, context: assembler({ ENABLE_PROMPT_CACHING_1H: '1' }) }))
    expect(inputs[0]?.cacheEnv).toEqual({ ENABLE_PROMPT_CACHING_1H: '1' })
  })

  it('an empty cacheEnv adds no field', async () => {
    const a = capture()
    await send(new TurnService({ db: fixture.db, runtime: a.runtime, stream: hub, now: () => NOW, context: assembler({}) }))
    expect(a.inputs[0] && 'cacheEnv' in a.inputs[0]).toBe(false)
  })
})
