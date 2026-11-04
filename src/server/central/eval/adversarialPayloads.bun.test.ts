// Bun-only (bun:sqlite). Runs every adversarial MCP call script through the real TurnService +
// ClaudeRuntime + `webterm mcp` + CA2 guard and checks the server state afterwards: refused receipts,
// no unintended goal or spawn, and the canary secret at 0.
import { expect, test } from 'bun:test'
import { redactToolArgs } from '../../mcp/mcp.tools'
import { REDACTED } from '../../redactSecrets'
import { createBrokerStore } from '../../secrets/secret.store'
import { getGoal } from '../goalStore'
import { adversarialPayloads, adversarialTools, CANARY_SECRET, goalInput, injectedNote, proposeGoal } from './adversarialPayloads'
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
      expect(h.tablesWith(CANARY_SECRET)).toEqual([])
      if (payload.category === 'secret_exfil') expect(getGoal(h.db, GOLDEN_PROJECT)?.statement).toBe(`Ship with ${REDACTED}`)
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

const BROKER_VALUE = 'plain-broker-value-7Q2' // test-only: no credential shape, only the broker store knows it

test('a broker-held value echoed into goal.propose is masked before it reaches any table', async () => {
  const h = await createHarness({ turns: [[proposeGoal(goalInput(GOLDEN_PROJECT, `Deploy using ${BROKER_VALUE} today`))]], tools: [] })
  try {
    createBrokerStore().write('DEPLOY_KEY', BROKER_VALUE) // harness points WEBTERM_DATA_DIR at its temp dir
    const submitted = h.service.submit({ conversationId: GOLDEN_CONVERSATION, clientMessageId: 'adv-broker', text: 'go' })
    expect((await submitted.done).status).toBe('succeeded')
    expect(getGoal(h.db, GOLDEN_PROJECT)?.statement).toBe(`Deploy using ${REDACTED} today`)
    expect(h.tablesWith(BROKER_VALUE)).toEqual([])
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('redactToolArgs scrubs only secrets and leaves the broker path and declared secret fields alone', () => {
  const known = (): string[] => [BROKER_VALUE]
  const args = { projectId: 'p1', n: 3, ok: true, none: null, list: ['a', `x ${CANARY_SECRET}`], nested: { deep: BROKER_VALUE, keep: 'fine' } }
  expect(redactToolArgs('goal.propose', args, known)).toEqual({ projectId: 'p1', n: 3, ok: true, none: null, list: ['a', `x ${REDACTED}`], nested: { deep: REDACTED, keep: 'fine' } })
  const run = { names: ['NPM_TOKEN'], command: ['npm', 'publish'] }
  expect(redactToolArgs('secret.run', run, known)).toBe(run)
  const bot = redactToolArgs('channel.bot.propose', { botToken: CANARY_SECRET, purpose: `p ${CANARY_SECRET}` }, known)
  expect(bot).toEqual({ botToken: CANARY_SECRET, purpose: `p ${REDACTED}` })
})
