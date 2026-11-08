import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { getOrCreateConversation, getTurn, listConversationEvents } from '../conversationStore'
import type { CentralRuntime, RuntimeEmit, TurnInput } from '../runtime/centralRuntime'
import { zeroUsage } from '../runtime/centralRuntime'
import { StreamHub } from './streamHub'
import { TurnService, listMessages } from './turnService'
import { centralTurnModel, conversationModelState, parseModelChoice, setConversationModel } from './conversationModelChoice'

const NOW = 1_700_000_000_000
const CONV = 'central:global'
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

/** Records inputs; every turn succeeds with a new session ref and reports the model it was asked for. */
function recording() {
  const inputs: TurnInput[] = []
  const runtime: CentralRuntime = {
    kind: 'claude',
    cancel: () => false,
    async turn(input: TurnInput, _emit: RuntimeEmit) {
      inputs.push(input)
      const model = input.model?.startsWith('claude-') ? input.model : `claude-${input.model ?? 'sonnet'}-5-5`
      return { turnId: input.turnId, outcome: 'success', text: 'ok', usage: { ...zeroUsage(), costMicros: 1234, model }, sessionRef: input.sessionRef ?? `ses_${inputs.length}` }
    },
  }
  return { runtime, inputs }
}

const send = (svc: TurnService, id: string) => svc.submit({ conversationId: CONV, clientMessageId: id, text: `msg ${id}` }).done
const choose = (model: string, effort?: string, env: NodeJS.ProcessEnv = {}) =>
  setConversationModel(fixture.db, hub, CONV, parseModelChoice(model, effort), env, 'claude', () => NOW)

describe('model precedence (conversation > setting > ladder)', () => {
  it('uses the ladder default for central without a choice or setting', () => {
    expect(centralTurnModel(fixture.db, CONV, {}, null)).toMatchObject({ model: 'sonnet', effort: 'medium', tier: 'T2' })
  })

  it('uses WEBTERM_CENTRAL_MODEL over the ladder, and the conversation choice over both', () => {
    const env = { WEBTERM_CENTRAL_MODEL: 'opus' }
    expect(centralTurnModel(fixture.db, CONV, env, null)).toMatchObject({ model: 'opus', effort: 'high', tier: 'T3' })
    choose('haiku', 'medium', env)
    expect(centralTurnModel(fixture.db, CONV, env, null)).toMatchObject({ model: 'haiku', effort: 'medium', tier: 'T1' })
    choose('auto', undefined, env)
    expect(centralTurnModel(fixture.db, CONV, env, null)).toMatchObject({ model: 'opus', tier: 'T3' })
  })

  it('passes a full claude-* setting through as typed', () => {
    expect(centralTurnModel(fixture.db, CONV, { WEBTERM_CENTRAL_MODEL: 'claude-opus-5-5' }, null)).toMatchObject({ model: 'claude-opus-5-5', tier: 'T3' })
  })

  it('rejects unknown models and efforts', () => {
    expect(() => parseModelChoice('gpt', undefined)).toThrow(/model must be one of/)
    expect(() => parseModelChoice('opus', 'turbo')).toThrow(/effort must be one of/)
  })
})

describe('/model takes effect only at a fresh session', () => {
  it('posts a notice, starts a fresh session on the next turn, then keeps that model while resuming', async () => {
    const { runtime, inputs } = recording()
    const svc = new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW, env: {} })

    await send(svc, 'c1')
    expect(inputs[0]).toMatchObject({ model: 'sonnet', effort: 'medium' })
    await send(svc, 'c2')
    expect(inputs[1]!.sessionRef).toBe('ses_1')

    const state = choose('opus', 'high')
    expect(state).toMatchObject({ alias: 'opus', effort: 'high', tier: 'T3', pending: true })
    const notice = listMessages(fixture.db, CONV).items.at(-1)!
    expect(notice.role).toBe('system')
    expect(JSON.stringify(notice.parts)).toMatch(/Model set to opus, high effort.*fresh session/)

    const third = await send(svc, 'c3')
    expect(inputs[2]!.sessionRef).toBeUndefined() // fresh session, not a mid-session switch
    expect(inputs[2]).toMatchObject({ model: 'opus', effort: 'high' })
    expect(getTurn(fixture.db, third.id)!.usage).toMatchObject({ tier: 'T3', effort: 'high', model: 'claude-opus-5-5' })

    await send(svc, 'c4')
    expect(inputs[3]).toMatchObject({ sessionRef: 'ses_3', model: 'claude-opus-5-5' })
    expect(conversationModelState(fixture.db, CONV, {}, 'claude')).toMatchObject({ alias: 'opus', pending: false })
  })

  it('keeps a resumed session on its model when the setting changes mid-session', async () => {
    const { runtime, inputs } = recording()
    const env: NodeJS.ProcessEnv = {}
    const svc = new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW, env })
    await send(svc, 'c1')
    env.WEBTERM_CENTRAL_MODEL = 'haiku'
    await send(svc, 'c2')
    expect(inputs[1]).toMatchObject({ sessionRef: 'ses_1', model: 'claude-sonnet-5-5' })
  })

  it('history carries each reply\'s usage for the cost chip', async () => {
    const { runtime } = recording()
    const svc = new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW, env: {} })
    await send(svc, 'c1')
    const reply = listMessages(fixture.db, CONV).items.find((m) => m.role === 'assistant')!
    expect(reply.usage).toMatchObject({ costMicros: 1234, tier: 'T2', effort: 'medium' })
  })
})
