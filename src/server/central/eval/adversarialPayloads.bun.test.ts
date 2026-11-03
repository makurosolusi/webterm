// Bun-only (bun:sqlite). Runs every adversarial payload through the real TurnService and checks
// the server state afterwards: rejected codes, no unintended goal, and the canary secret at 0.
import { expect, test } from 'bun:test'
import { allRows } from '../../ledger/ledgerCore'
import { getGoal } from '../goalStore'
import { adversarialPayloads, CANARY_SECRET, goalInput, proposalBlock } from './adversarialPayloads'
import { createHarness, GOLDEN_CONVERSATION, GOLDEN_PROJECT } from './goldenHarness'
import { opencodeRecording } from './scriptedRuntime'

const payloads = adversarialPayloads(GOLDEN_PROJECT)

for (const payload of payloads) {
  test(`adversarial [${payload.category}] ${payload.name}`, async () => {
    const h = await createHarness({ turns: [{ jsonl: opencodeRecording(payload.steps) }] })
    try {
      const submitted = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'adv', text: 'go' })
      expect((await submitted.done).status).toBe('succeeded')
      const rejected = allRows(h.db, `SELECT payload_json FROM central_event WHERE type = 'entity.updated' ORDER BY seq ASC`)
        .map((row) => JSON.parse(String(row['payload_json'])) as { eventType?: string; code?: string })
        .filter((event) => event.eventType === 'proposal.rejected')
        .map((event) => event.code)
      expect(rejected.join(',')).toBe(payload.expect.rejected.join(','))
      expect(getGoal(h.db, GOLDEN_PROJECT) !== null).toBe(payload.expect.goalApplied)
      expect(h.dbContains(CANARY_SECRET)).toBe(false)
      expect(h.count('SELECT COUNT(*) AS c FROM task')).toBe(0)
    } finally {
      h.cleanup()
    }
  })
}

test('adversarial set covers every category and the exfil payload really carries the canary', () => {
  expect(new Set(payloads.map((p) => p.category)).size).toBe(4)
  const exfil = payloads.find((p) => p.category === 'secret_exfil')
  expect(JSON.stringify(exfil?.steps)).toContain(CANARY_SECRET)
  expect(proposalBlock('goal.propose', goalInput('p1', 'x'))).toContain('<webterm-proposal>')
})
