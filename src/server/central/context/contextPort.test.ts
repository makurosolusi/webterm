import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFixture, seedPortfolio, type Fixture } from '../centralTestFixture.testutil'
import { appendMessage, getOrCreateConversation } from '../conversationStore'
import { HISTORY_LIMIT, createLegacyContextAssembler } from './contextPort'

let fixture: Fixture
beforeEach(() => {
  fixture = openFixture()
  seedPortfolio(fixture.db)
  getOrCreateConversation(fixture.db, 'global', 1)
})
afterEach(() => fixture.close())

const base = () => ({
  db: fixture.db, conversationId: 'central:global', text: 'status?',
  memoryEnabled: false, now: () => 1,
})

describe('legacy context assembler', () => {
  it('returns the plain human text when memory is off', () => {
    expect(createLegacyContextAssembler().build(base())).toEqual({ prompt: 'status?', history: [] })
  })

  it('caps history at the last 20 message ids, oldest first', () => {
    const ids: string[] = []
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
      ids.push(appendMessage(fixture.db, {
        conversationId: 'central:global', role: 'human', parts: [{ type: 'text', text: `m${i}` }], now: i + 2,
      }).message.id)
    }
    const { history } = createLegacyContextAssembler().build(base())
    expect(history).toEqual(ids.slice(-HISTORY_LIMIT))
    expect(history).toHaveLength(20)
  })
})
