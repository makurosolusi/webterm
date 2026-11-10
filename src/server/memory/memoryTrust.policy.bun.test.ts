// Policy (decision 5): what the user said or the server verified is a fact; what an agent wrote stays a claim.
import { expect, test } from 'bun:test'
import { writeProposals } from './consolidator/consolidator.store'
import { rememberClaim, rememberUser } from './memoryRemember'
import { T0, addMessage, fixture, seedRow, subset } from './memoryV2.fixture'

const ctx = { conversationId: 'central:global', projectId: null, now: T0 }

test('an attested user quote is a fact, and only the quote is stored', async () => {
  const db = fixture()
  addMessage(db, ctx.conversationId, 'human', 'Please reply in Indonesian from now on.')
  const { record } = await rememberUser(db, ctx, { key: 'user.lang.reply', quote: 'reply in Indonesian', summary: 'paraphrase' })
  subset(record, { status: 'fact', trust: 'attested', scope: 'user', sourceKind: 'user_quote', body: 'reply in Indonesian' })
  expect(record.verifiedAt).toBe(T0)
})

test('an agent note is an unverified claim, even for the kind fact', () => {
  const { record } = rememberClaim(fixture(), ctx, { key: 'central.note.one', body: 'the agent thinks so', kind: 'fact' })
  subset(record, { status: 'claim', trust: 'agent', scope: 'central', verifiedAt: null })
})

test('a consolidator proposal is an unverified claim', () => {
  const db = fixture()
  const out = writeProposals(db, [{ op: 'add', kind: 'fact', text: 'derived from a transcript', targetId: null }], { nodeId: 'a1', sourceEventId: null, projectId: 'p1' }, T0)
  expect(out.written.length).toBe(1)
  subset(db.query('SELECT status, trust, scope, project_id FROM memory WHERE id = ?').get(out.written[0]!), { status: 'claim', trust: 'agent', scope: 'central', project_id: 'p1' })
})

test('external content can never be stored as a fact', () => {
  const db = fixture()
  let code = ''
  try { seedRow(db, { key: 'global.web.one', body: 'from a page', trust: 'external' }) } catch (err) { code = (err as { code: string }).code }
  expect(code).toBe('untrusted_source')
})
