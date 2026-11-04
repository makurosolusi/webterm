// Bun-only (bun:sqlite). Eval cases from user rejections: v21 migration, capture from the four rejection
// sources (scrubbed), human decisions and the HTTP route.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { Database as Db } from 'bun:sqlite'
import { createEventLog } from '../events/eventLog'
import { approvalDigest, decideApproval, requestApproval } from '../ledger/ledgerApproval'
import { MIGRATIONS } from '../ledger/ledgerSchema'
import { applyV21 } from '../ledger/ledgerSchemaV21'
import { LATEST_VERSION, migrate } from '../ledger/migration'
import { appendMemoryEvent, memoryContext } from '../memory/memoryCore'
import { forgetMemory } from '../memory/memoryControls'
import { addMessage, fixture, seedRow, T0 } from '../memory/memoryV2.fixture'
import { syncEvalCases } from './evalCase.capture'
import { evalCasesRoute, type EvalCasesDeps } from './evalCase.route'
import { listEvalCases } from './evalCase.store'

const BROKER_SECRET = 'broker-value-123456' // test-only
const CONVERSATION = 'central:project:p1'
const ARGS = { projectId: 'p1', statement: 'Delete the staging database', token: 'ghp_abcdefghijklmnop1234' } // test-only

/** One rejection of each kind, through the real producers (approval decide, forget, Senses log). */
function seedRejections(db: Db): void {
  const ctx = { db, now: () => T0 }
  addMessage(db, CONVERSATION, 'human', `Clean up staging, mail me at ana@example.com, key ${BROKER_SECRET}`)
  const plan = requestApproval(ctx, { projectId: 'p1', kind: 'goal.propose', request: { tool: 'goal.propose', conversationId: CONVERSATION, input: ARGS, inputDigest: approvalDigest(ARGS) } })
  decideApproval(ctx, plan.id, { actor: 'human:loopback', approve: false, digest: plan.digest, nonce: plan.nonce })
  const perm = requestApproval(ctx, { projectId: 'p1', kind: 'permission', request: { tool: 'Bash', label: 'Bash(rm -rf build)', nodeId: 'n1', input: { command: 'rm -rf build' } } })
  decideApproval(ctx, perm.id, { actor: 'telegram:42', approve: false, digest: perm.digest, nonce: perm.nonce })
  const kept = requestApproval(ctx, { projectId: 'p1', kind: 'permission', request: { tool: 'Read' } })
  decideApproval(ctx, kept.id, { actor: 'human:loopback', approve: true, digest: kept.digest, nonce: kept.nonce })

  const mem = seedRow(db, { key: 'consolidate:add:x', body: 'User prefers tabs', scope: 'central', status: 'claim', trust: 'agent', sourceKind: 'consolidator', sourceRef: 'node:n2' })
  appendMemoryEvent(memoryContext(db, T0), mem, 'consolidator', 'memory.consolidate.propose', { op: 'add', targetId: null, node: 'n2' }, T0)
  forgetMemory(db, { kind: 'human', id: 'human-ui' }, mem, T0 + 1)

  const log = createEventLog(db, { now: () => T0 })
  log.append({ kind: 'checkpoint.created', source: 'checkpoint', subject: 'checkpoint:w1/3', workspaceId: 'w1', nodeId: 'n3', trust: 'trusted', payload: { seq: 3, reason: 'before prompt', rewindable: true } })
  log.append({ kind: 'checkpoint.rewound', source: 'checkpoint', actor: 'human-ui', subject: 'checkpoint:w1/3', workspaceId: 'w1', trust: 'trusted', payload: { seq: 3, undoSeq: 4 } })
}

const opts = { now: T0 + 10, secrets: [BROKER_SECRET] }

test('v19 ledger -> v21 adds eval_case; re-run of the step keeps rows', () => {
  const db = new Database(':memory:')
  expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 19))).toBe(19)
  expect(migrate(db)).toBe(LATEST_VERSION)
  db.exec(`INSERT INTO eval_case (id, source, source_ref, proposed_json, rejection_json, rejected_at, created_at, updated_at)
    VALUES ('e1', 'rewind', 'event:1', '{}', '{}', 1, 1, 1)`)
  applyV21(db)
  expect(db.query('SELECT COUNT(*) AS n FROM eval_case').get()).toEqual({ n: 1 })
})

test('captures each rejection source once, scrubbed; approved and dismissed never come back', () => {
  const db = fixture()
  seedRejections(db)
  expect(syncEvalCases(db, opts)).toBe(4)
  expect(syncEvalCases(db, opts)).toBe(0)
  const { cases, total } = listEvalCases(db)
  expect(total).toBe(4)
  const by = Object.fromEntries(cases.map((c) => [c.source, c]))
  expect(Object.keys(by).sort()).toEqual(['approval', 'central_plan', 'memory_proposal', 'rewind'])

  const plan = by['central_plan']!
  expect(plan.contextRef).toBe(`conversation:${CONVERSATION}`)
  expect(plan.workspaceId).toBe('w1')
  expect(plan.proposed.tool).toBe('goal.propose')
  expect(plan.proposed.inputDigest).toBe(approvalDigest(ARGS))
  expect(plan.rejection).toEqual({ by: 'human:loopback', how: 'approval' })
  expect(plan.inputText).toContain('[email]')
  const stored = JSON.stringify(cases)
  for (const leak of ['ana@example.com', BROKER_SECRET, 'ghp_abcdefghijklmnop1234']) expect(stored.includes(leak)).toBe(false)

  expect(by['approval']!.proposed.summary).toBe('Bash: Bash(rm -rf build)')
  expect(by['approval']!.rejection.by).toBe('telegram:42')
  expect(by['memory_proposal']!.proposed).toMatchObject({ tool: 'memory.add', summary: 'Consolidator proposed to add a fact' })
  expect(stored.includes('User prefers tabs')).toBe(false) // forgotten text stays forgotten
  expect(by['rewind']!).toMatchObject({ contextRef: 'checkpoint:w1/3', nodeId: 'n3', rejection: { by: 'human-ui', how: 'checkpoint.rewound' } })
  expect(by['rewind']!.proposed.summary).toBe('Changes made after checkpoint 3 (before prompt)')
})

test('route: list by status, promote with a scrubbed reason, export holds promoted only, errors are 4xx', async () => {
  const db = fixture()
  seedRejections(db)
  const deps: EvalCasesDeps = { db, now: () => T0 + 20, secrets: () => [BROKER_SECRET] }
  const call = (path: string, method = 'GET', body = '') => evalCasesRoute(new URL(`http://x${path}`), method, async () => body, deps)

  const all = await call('/api/evalcases?status=new&limit=2')
  expect(all?.status).toBe(200)
  const page = all?.body as { cases: Array<{ id: string; source: string }>; total: number }
  expect(page.total).toBe(4)
  expect(page.cases).toHaveLength(2)
  const plan = listEvalCases(db).cases.find((c) => c.source === 'central_plan')!
  const rewind = listEvalCases(db).cases.find((c) => c.source === 'rewind')!

  const promoted = await call(`/api/evalcases/${plan.id}/promote`, 'POST', JSON.stringify({ reason: `Never drop staging; ping bob@example.com ${BROKER_SECRET}` }))
  expect(promoted?.status).toBe(200)
  expect((promoted?.body as { case: { status: string; reason: string } }).case).toMatchObject({ status: 'promoted', reason: 'Never drop staging; ping [email] [redacted]' })
  expect((await call(`/api/evalcases/${rewind.id}/dismiss`, 'POST'))?.status).toBe(200)

  const exported = (await call('/api/evalcases/export'))?.body as { format: string; cases: Array<{ id: string }> }
  expect(exported.format).toBe('webterm-eval-cases/1')
  expect(exported.cases.map((c) => c.id)).toEqual([plan.id])
  expect(((await call('/api/evalcases?status=dismissed'))?.body as { total: number }).total).toBe(1)

  expect((await call('/api/evalcases/nope/promote', 'POST'))?.status).toBe(404)
  expect((await call('/api/evalcases?status=bogus'))?.status).toBe(400)
  expect((await call(`/api/evalcases/${plan.id}/promote`, 'POST', '[1]'))?.status).toBe(400)
  expect((await call(`/api/evalcases/${plan.id}/promote`, 'POST', JSON.stringify({ reason: 7 })))?.status).toBe(400)
  expect((await call(`/api/evalcases/${plan.id}/promote`))?.status).toBe(405)
  expect(await call('/api/other')).toBeNull()
})
