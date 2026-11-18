import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allRows } from '../../ledger/ledgerCore'
import { openFixture, type Fixture } from '../centralTestFixture.testutil'
import { registerCapabilityMap, type MapTool } from '../context/capabilityMap'
import { getOrCreateConversation, listConversationEvents } from '../conversationStore'
import { MockRuntime } from '../runtime/mockRuntime'
import { createChatConversation } from './turnPersistence'
import { StreamHub } from './streamHub'
import { TurnService } from './turnService'

let fixture: Fixture
let hub: StreamHub
let clock = 1_700_000_000_000
let tools: MapTool[] = []
let unregister = (): void => undefined
const now = (): number => clock

const ON: MapTool[] = [{ name: 'browser_read', access: 'auto' }, { name: 'browser_act', access: 'asks' }]
const OFF: MapTool[] = [{ name: 'browser_read', access: 'off' }, { name: 'browser_act', access: 'off' }]

beforeEach(() => {
  fixture = openFixture()
  getOrCreateConversation(fixture.db, 'global', clock)
  hub = new StreamHub({ replay: (id, after) => listConversationEvents(fixture.db, id, after, 500), heartbeatMs: 0 })
  tools = ON
  unregister = registerCapabilityMap(() => tools)
})
afterEach(() => { unregister(); hub.close(); fixture.close() })

async function ask(id: string, conv = 'central:global'): Promise<string> {
  const svc = new TurnService({ db: fixture.db, runtime: new MockRuntime({ mode: 'success', stepDelayMs: 0 }), stream: hub, now })
  clock += 10
  const turn = await svc.submit({ conversationId: conv, clientMessageId: id, text: 'hello' }).done
  expect(turn.status).toBe('succeeded')
  return String(allRows(fixture.db, "SELECT parts_json FROM central_message WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1", conv)[0]?.parts_json)
}
const notices = (conv: string): string[] =>
  allRows(fixture.db, "SELECT parts_json FROM central_message WHERE conversation_id = ? AND role = 'system'", conv).map((r) => String(r.parts_json)).filter((n) => n.includes('Capabilities updated'))

describe('Capabilities updated note (Central)', () => {
  it('the first turn only records; no change means no note; a flip is told exactly once with the briefing', async () => {
    expect(await ask('m0')).not.toContain('Capabilities updated')
    expect(await ask('m1')).not.toContain('Capabilities updated')
    tools = OFF
    const reply = await ask('m2')
    expect(reply).toContain('[webterm] Capabilities updated: Can ')
    expect(reply).toContain('Not available right now: read public web pages (read-only), drive web pages and have links opened from a terminal appear in the canvas browser.')
    expect(reply).toContain('NOT AVAILABLE RIGHT NOW')
    expect(notices('central:global')).toHaveLength(1)
    expect(await ask('m3')).not.toContain('Capabilities updated')
    expect(notices('central:global')).toHaveLength(1)
    tools = ON
    expect(await ask('m4')).toContain('Capabilities updated')
    expect(notices('central:global')).toHaveLength(2)
  })

  it('does not leak between conversations', async () => {
    const other = createChatConversation(fixture.db, clock).id
    await ask('g0')
    await ask('o0', other)
    tools = OFF
    expect(await ask('o1', other)).toContain('Capabilities updated')
    expect(notices(other)).toHaveLength(1)
    expect(notices('central:global')).toHaveLength(0)
    expect(await ask('g1')).toContain('Capabilities updated') // its own first look since its last turn
  })

  it('an unarmed Central (no catalog) neither records nor announces', async () => {
    tools = []
    await ask('a0')
    tools = OFF
    expect(await ask('a1')).not.toContain('Capabilities updated') // first real look: records only
    expect(allRows(fixture.db, "SELECT 1 FROM event WHERE kind = 'agent.capabilities'")).toHaveLength(1)
  })
})
