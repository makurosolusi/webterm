import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allRows } from '../../ledger/ledgerCore'
import { openFixture, type Fixture } from '../centralTestFixture.testutil'
import { getOrCreateConversation, listConversationEvents } from '../conversationStore'
import { MockRuntime } from '../runtime/mockRuntime'
import { recordSkillToggle, SKILL_TOGGLE_KIND } from '../skills/skillToggleAudit'
import { createChatConversation } from './turnPersistence'
import { StreamHub } from './streamHub'
import { TurnService } from './turnService'

let fixture: Fixture
let hub: StreamHub
let clock = 1_700_000_000_000
const now = (): number => clock

beforeEach(() => {
  fixture = openFixture()
  getOrCreateConversation(fixture.db, 'global', clock)
  hub = new StreamHub({ replay: (id, after) => listConversationEvents(fixture.db, id, after, 500), heartbeatMs: 0 })
})
afterEach(() => { hub.close(); fixture.close() })

const toggle = (name: string, from: boolean, to: boolean, audience = 'central'): void => {
  clock += 10
  recordSkillToggle({ db: fixture.db, now }, { name, version: '1', audience, from, to }, 'human:root')
}

/** Submits a turn and returns the prompt the runtime received (the mock echoes it back). */
async function ask(id: string, conv = 'central:global'): Promise<string> {
  const svc = new TurnService({ db: fixture.db, runtime: new MockRuntime({ mode: 'success', stepDelayMs: 0 }), stream: hub, now })
  clock += 10
  const turn = await svc.submit({ conversationId: conv, clientMessageId: id, text: 'hello' }).done
  expect(turn.status).toBe('succeeded')
  return String(allRows(fixture.db, "SELECT parts_json FROM central_message WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1", conv)[0]?.parts_json)
}

const notices = (conv: string): string[] =>
  allRows(fixture.db, "SELECT parts_json FROM central_message WHERE conversation_id = ? AND role = 'system'", conv).map((r) => String(r.parts_json))

describe('Skills changed note', () => {
  it('appears once after a toggle, not on an unchanged turn, and not on the first turn', async () => {
    toggle('webterm-a', true, false)
    expect(await ask('m0')).not.toContain('Skills changed')
    toggle('webterm-a', false, true)
    toggle('webterm-b', true, false)
    const reply = await ask('m1')
    expect(reply).toContain('[webterm] Skills changed: +webterm-a / -webterm-b')
    expect(notices('central:global').filter((n) => n.includes('Skills changed'))).toHaveLength(1)
    expect(await ask('m2')).not.toContain('Skills changed')
    expect(notices('central:global').filter((n) => n.includes('Skills changed'))).toHaveLength(1)
  })

  it('a flip and flip back nets to nothing; canvas skills are not announced', async () => {
    await ask('m0')
    toggle('webterm-a', true, false)
    toggle('webterm-a', false, true)
    toggle('webterm-canvas', true, false, 'canvas')
    expect(await ask('m1')).not.toContain('Skills changed')
  })

  it('does not leak between conversations', async () => {
    const other = createChatConversation(fixture.db, clock).id
    await ask('g0')
    await ask('o0', other)
    toggle('webterm-a', true, false)
    expect(await ask('o1', other)).toContain('Skills changed: -webterm-a')
    expect(await ask('g1')).toContain('Skills changed: -webterm-a') // its own first look since its last turn
    expect(notices(other).filter((n) => n.includes('Skills changed'))).toHaveLength(1)
  })

  it('writes one audit row per real flip and none for a repeat', () => {
    toggle('webterm-a', true, true)
    toggle('webterm-a', true, false)
    const rows = allRows(fixture.db, 'SELECT actor, payload_json FROM event WHERE kind = ?', SKILL_TOGGLE_KIND)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'human:root' })
    expect(JSON.parse(String(rows[0].payload_json))).toMatchObject({ skill: 'webterm-a', version: '1', from: true, to: false })
  })
})
