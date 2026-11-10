import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { getOrCreateConversation, listConversationEvents } from '../conversationStore'
import { createContextAssembler, type SyncMemoryBlockProvider } from '../context/contextAssembler'
import type { ContextAssembler } from '../context/contextPort'
import type { CentralRuntime, RuntimeEmit, TurnInput } from '../runtime/centralRuntime'
import { zeroUsage } from '../runtime/centralRuntime'
import { StreamHub } from './streamHub'
import { TurnService } from './turnService'

const NOW = 1_700_000_000_000
const CONVERSATION = 'central:global'
let fixture: Fixture
let hub: StreamHub
const previousCentral = process.env.WEBTERM_CENTRAL

beforeEach(() => {
  process.env.WEBTERM_CENTRAL = 'on'
  fixture = openFixture()
  seedPortfolio(fixture.db)
  getOrCreateConversation(fixture.db, 'global', NOW)
  hub = new StreamHub({ replay: (id, after) => listConversationEvents(fixture.db, id, after, 500), heartbeatMs: 0 })
})
afterEach(() => {
  hub.close()
  fixture.close()
  if (previousCentral === undefined) delete process.env.WEBTERM_CENTRAL
  else process.env.WEBTERM_CENTRAL = previousCentral
})

const runtime: CentralRuntime = {
  kind: 'mock',
  cancel: () => false,
  close: async () => undefined,
  async turn(input: TurnInput, _emit: RuntimeEmit) {
    return { turnId: input.turnId, outcome: 'success' as const, text: 'ok', usage: zeroUsage(), sessionRef: null }
  },
} as unknown as CentralRuntime

const memory: SyncMemoryBlockProvider = {
  block: () => ({
    text: 'deploy goes through staging', truncated: false,
    items: [{ id: 'mem_a', scope: 'project', trust: 'human', kind: 'fact', key: 'deploy.path' }, { id: 'mem_b', scope: 'central', trust: 'agent', kind: 'claim', key: 'deploy.when' }],
  }),
}
const send = (context: ContextAssembler | undefined, id: string) =>
  new TurnService({ db: fixture.db, runtime, stream: hub, now: () => NOW, env: {}, ...(context ? { context } : {}) })
    .submit({ conversationId: CONVERSATION, clientMessageId: id, text: `msg ${id}` }).done
const traceOf = (turnId: string): unknown => JSON.parse(String((fixture.db.query('SELECT context_json AS j FROM central_turn WHERE id = ?').get(turnId) as { j: string }).j))

describe('central_turn.context_json', () => {
  it('records the memory ids the provider actually selected, and the header that was sent', async () => {
    const turn = await send(createContextAssembler({ env: {}, memory, scheduleIdle: () => undefined }), 'a')
    expect(traceOf(turn.id)).toEqual({
      memoryIds: ['mem_a', 'mem_b'], checkpointId: null,
      headerHash: expect.stringMatching(/^[0-9a-f]{64}$/), headerChars: expect.any(Number),
      stateVersions: { global: null, project: null },
    })
    expect((traceOf(turn.id) as { headerChars: number }).headerChars).toBeGreaterThan(0)
  })

  it('still writes a trace when the assembler reports none', async () => {
    const context = { build: () => ({ prompt: 'p', history: [] }) } as ContextAssembler
    expect(traceOf((await send(context, 'b')).id)).toEqual({ memoryIds: [], checkpointId: null, headerHash: '', headerChars: 0, stateVersions: { global: null, project: null } })
  })
})
