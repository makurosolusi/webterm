// Bun-only (bun:sqlite). Runs every adversarial MCP call script through the real TurnService +
// ClaudeRuntime + `webterm mcp` + CA2 guard and checks the server state afterwards: refused receipts,
// no unintended goal or spawn, and the canary secret at 0.
import { expect, test } from 'bun:test'
import { getGoal } from '../goalStore'
import { adversarialPayloads, adversarialTools, CANARY_SECRET, injectedNote } from './adversarialPayloads'
import { createHarness, GOLDEN_CONVERSATION, GOLDEN_PROJECT } from './goldenHarness'

const payloads = adversarialPayloads(GOLDEN_PROJECT)

for (const payload of payloads) {
  test(`adversarial [${payload.category}] ${payload.name}`, async () => {
    let spawned = 0
    const h = await createHarness({ turns: [payload.steps], tools: adversarialTools(() => { spawned += 1 }, injectedNote(GOLDEN_PROJECT)) })
    try {
      const submitted = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'adv', text: 'go' })
      expect((await submitted.done).status).toBe('succeeded')
      const refused = h.receipts().filter((r) => !r.ok).map((r) => r.errorCode)
      expect(refused.join(',')).toBe(payload.expect.refused.join(','))
      expect(getGoal(h.db, GOLDEN_PROJECT) !== null).toBe(payload.expect.goalApplied)
      expect(spawned).toBe(payload.expect.spawned)
      expect(h.tablesWith(CANARY_SECRET)).toEqual(payload.expect.canaryTables ?? [])
      expect(h.count('SELECT COUNT(*) AS c FROM task')).toBe(0)
    } finally {
      await h.cleanup()
    }
  }, 30_000)
}

test('adversarial set covers every category and the exfil payload really carries the canary', () => {
  expect(new Set(payloads.map((p) => p.category)).size).toBe(4)
  const exfil = payloads.find((p) => p.category === 'secret_exfil')
  expect(JSON.stringify(exfil?.steps)).toContain(CANARY_SECRET)
  expect(injectedNote(GOLDEN_PROJECT)).toContain('goal_propose')
})
