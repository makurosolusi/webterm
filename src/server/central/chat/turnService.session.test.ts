import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { getOrCreateConversation, getTurn, listConversationEvents, sessionRefFor } from '../conversationStore'
import type { CentralRuntime, RuntimeEmit, TurnInput } from '../runtime/centralRuntime'
import { zeroUsage } from '../runtime/centralRuntime'
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

/** Runtime that records inputs and returns scripted outcomes (sessionRef is what a CLI would report). */
function scripted(script: Array<{ outcome: 'success' | 'error'; sessionRef: string | null }>) {
  const inputs: TurnInput[] = []
  const runtime: CentralRuntime = {
    kind: 'mock',
    cancel: () => false,
    async turn(input: TurnInput, _emit: RuntimeEmit) {
      inputs.push(input)
      const step = script[inputs.length - 1]!
      return {
        turnId: input.turnId, outcome: step.outcome, text: 'ok', usage: zeroUsage(),
        sessionRef: step.sessionRef, ...(step.outcome === 'error' ? { errorCode: 'runtime_error' as const } : {}),
      }
    },
  }
  return { runtime, inputs }
}

function send(svc: TurnService, id: string) {
  return svc.submit({ conversationId: 'central:global', clientMessageId: id, text: `msg ${id}` }).done
}

describe('session continuity (B1)', () => {
  it('passes the last successful session_ref to the next turn, skipping failed turns', async () => {
    const { runtime, inputs } = scripted([
      { outcome: 'success', sessionRef: 'ses_A' },
      { outcome: 'error', sessionRef: 'ses_BAD' },
      { outcome: 'success', sessionRef: null },
      { outcome: 'success', sessionRef: 'ses_C' },
    ])
    const svc = new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW })

    await send(svc, 'c1')
    expect(inputs[0]!.sessionRef).toBeUndefined()

    const second = await send(svc, 'c2')
    expect(inputs[1]!.sessionRef).toBe('ses_A')
    expect(second.status).toBe('failed')

    await send(svc, 'c3')
    expect(inputs[2]!.sessionRef).toBe('ses_A')

    await send(svc, 'c4')
    expect(sessionRefFor(fixture.db, 'central:global')).toBe('ses_C')
  })

  it('stores the inherited ref on the new turn row', async () => {
    const { runtime } = scripted([{ outcome: 'success', sessionRef: 'ses_A' }, { outcome: 'success', sessionRef: 'ses_A' }])
    const svc = new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW })
    await send(svc, 'c1')
    const second = svc.submit({ conversationId: 'central:global', clientMessageId: 'c2', text: 'again' })
    expect(getTurn(fixture.db, second.response.turnId)!.sessionRef).toBe('ses_A')
    await second.done
  })

  it('keeps sessions separate per conversation', async () => {
    const { runtime, inputs } = scripted([{ outcome: 'success', sessionRef: 'ses_G' }, { outcome: 'success', sessionRef: null }])
    const svc = new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW })
    await send(svc, 'c1')
    await svc.submit({ conversationId: 'central:project:p1', clientMessageId: 'c2', text: 'x' }).done
    expect(inputs[1]!.sessionRef).toBeUndefined()
  })
})

describe('turn limits (B3)', () => {
  it('fills limits from the injected env, with defaults otherwise', async () => {
    const { runtime, inputs } = scripted([{ outcome: 'success', sessionRef: null }, { outcome: 'success', sessionRef: null }])
    const defaults = new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW, env: {} })
    await send(defaults, 'c1')
    expect(inputs[0]!.limits).toEqual({ maxTurns: 12, maxWallMs: 120_000 })

    const custom = new TurnService({
      db: fixture.db, runtime, stream: hub, now: () => NOW, env: { WEBTERM_CENTRAL_TURN_WALL_MS: '30000' },
    })
    await send(custom, 'c2')
    expect(inputs[1]!.limits).toMatchObject({ maxWallMs: 30_000, maxTurns: 12 })
  })
})
