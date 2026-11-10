// Self-started turns: nobody typed them, they are budgeted at the door and every other rule is untouched.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { createContextAssembler } from '../context/contextAssembler'
import { getOrCreateConversation, listConversationEvents } from '../conversationStore'
import type { CentralRuntime, RuntimeEmit, TurnInput } from '../runtime/centralRuntime'
import { zeroUsage } from '../runtime/centralRuntime'
import { StreamHub } from './streamHub'
import { CentralChatError, TurnService, listMessages } from './turnService'
import { systemTurnsToday } from './turnOrigin'

const NOW = 1_700_000_000_000
const CONVERSATION = 'central:global'
const PROMPT = 'Automatic check-in from webterm. This is not a message from the user.'
const origin = (dailyLimit = 10) => ({ kind: 'system' as const, notice: 'Central checked in: task X stalled', dailyLimit })
let f: Fixture
let hub: StreamHub
let inputs: TurnInput[]
let svc: TurnService

const runtime: CentralRuntime = {
  kind: 'mock',
  cancel: () => false,
  async turn(input: TurnInput, _emit: RuntimeEmit) {
    inputs.push(input)
    return { turnId: input.turnId, outcome: 'success' as const, text: 'ok', usage: zeroUsage(), sessionRef: null }
  },
}

beforeEach(() => {
  f = openFixture()
  seedPortfolio(f.db)
  getOrCreateConversation(f.db, 'global', NOW)
  hub = new StreamHub({ replay: (id, after) => listConversationEvents(f.db, id, after, 500), heartbeatMs: 0 })
  inputs = []
  svc = new TurnService({ db: f.db, runtime, stream: hub, now: () => NOW, env: {} })
})
afterEach(() => { hub.close(); f.close() })

const submit = (id: string, dailyLimit?: number) => svc.submit({ conversationId: CONVERSATION, clientMessageId: id, text: PROMPT, origin: origin(dailyLimit) })
const originOf = (turnId: string) => (f.db.query('SELECT origin FROM central_turn WHERE id = ?').get(turnId) as { origin: string }).origin
const roles = () => listMessages(f.db, CONVERSATION).items.map((m) => m.role)

describe('system-origin turns', () => {
  it('shows a system notice, records the origin and writes no human message', async () => {
    const { response, done } = submit('c1')
    await done
    expect(roles()).toEqual(['system', 'assistant'])
    const [first] = listMessages(f.db, CONVERSATION).items
    expect(first?.parts).toEqual([{ type: 'notice', text: 'Central checked in: task X stalled' }])
    expect(first?.turnId).toBe(response.turnId)
    expect(originOf(response.turnId)).toBe('system')
    expect(inputs[0]?.text).toBe(PROMPT)
    const created = listConversationEvents(f.db, CONVERSATION, 0, 50).find((e) => e.type === 'message.created')
    expect((created?.payload as { role: string }).role).toBe('system')
  })

  it('never labels the prompt as a human request, with the real assembler too', async () => {
    const real = new TurnService({ db: f.db, runtime, stream: hub, now: () => NOW, env: {}, context: createContextAssembler({}) })
    await real.submit({ conversationId: CONVERSATION, clientMessageId: 'c1', text: PROMPT, origin: origin() }).done
    expect(inputs[0]?.text).toContain(PROMPT)
    expect(inputs[0]?.text).not.toContain('Human request:')
    await real.submit({ conversationId: CONVERSATION, clientMessageId: 'h1', text: 'hello' }).done
    expect(inputs[1]?.text).toContain('Human request:\nhello')
  })

  it('a typed message stays a human turn and is not counted', async () => {
    const { response, done } = svc.submit({ conversationId: CONVERSATION, clientMessageId: 'h1', text: 'hello' })
    await done
    expect(roles()).toEqual(['human', 'assistant'])
    expect(originOf(response.turnId)).toBe('user')
    expect(systemTurnsToday(f.db, NOW)).toBe(0)
  })

  it('at the limit it is refused with nothing written', async () => {
    await submit('c1', 1).done
    const before = roles().length
    let code = ''
    try { submit('c2', 1) } catch (err) { code = (err as CentralChatError).code }
    expect(code).toBe('budget_exhausted')
    expect(roles().length).toBe(before)
    expect(systemTurnsToday(f.db, NOW)).toBe(1)
  })

  it('the same batch id replays instead of starting a second turn, even at the limit', async () => {
    const a = submit('c1', 1)
    await a.done
    expect(submit('c1', 1).response.turnId).toBe(a.response.turnId)
    expect(inputs.length).toBe(1)
  })

  it('takes the conversation lock like any turn', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    const slow = new TurnService({ db: f.db, runtime: { ...runtime, turn: async (input, emit) => { await held; return runtime.turn(input, emit) } }, stream: hub, now: () => NOW, env: {} })
    const first = slow.submit({ conversationId: CONVERSATION, clientMessageId: 'c1', text: PROMPT, origin: origin() })
    let code = ''
    try { slow.submit({ conversationId: CONVERSATION, clientMessageId: 'c2', text: PROMPT, origin: origin() }) } catch (err) { code = (err as CentralChatError).code }
    expect(code).toBe('conversation_busy')
    release()
    await first.done
  })
})
