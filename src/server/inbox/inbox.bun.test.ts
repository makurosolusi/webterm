// Bun-only (needs bun:sqlite). Verifies the state-first inbox is ordered,
// paginated, project-scoped, clock-driven, and strictly read-only.
import { expect, test } from 'bun:test'
import { openLedgerDb } from '../ledger/migration'
import { createLedger, type Ledger } from '../ledger/ledger'
import { allRows } from '../ledger/ledgerCore'
import { buildInbox, inboxCounts } from './inbox'

const T0 = 1_700_000_000_000

function fixture() {
  const db = openLedgerDb(':memory:')
  const ledger = createLedger(db, { now: T0 })
  ledger.project.createProject({ id: 'p1', workspaceId: 'w1', name: 'Alpha', path: '/tmp/a' })
  ledger.project.createProject({ id: 'p2', workspaceId: 'w2', name: 'Beta', path: '/tmp/b' })
  return { db, ledger }
}

function blocked(ledger: Ledger, projectId: string, at: number, spec = 'blocked task') {
  const task = ledger.task.createTask({ projectId, spec, now: at })
  ledger.task.blockTask(task.id, 'waiting on human')
  return task
}

function claimed(ledger: Ledger, projectId: string, at: number) {
  const task = ledger.task.createTask({ projectId, spec: 'claim work', now: at })
  const leased = ledger.task.leaseTask(task.id, { owner: 'w', ttlMs: 60_000, now: at })!
  ledger.task.claimDone(task.id, leased.fence, { command: 'bun test', exitCode: 0 }, { owner: 'w' })
  return task
}

function suspect(ledger: Ledger, projectId: string, at: number) {
  const task = ledger.task.createTask({ projectId, spec: 'suspect work', now: at })
  ledger.task.leaseTask(task.id, { owner: 'w', ttlMs: 1000, now: at })
  ledger.task.releaseToSuspect(task.id, at + 1000)
  return task
}

function failed(ledger: Ledger, projectId: string, at: number) {
  const task = ledger.task.createTask({ projectId, spec: 'failed work', now: at })
  const leased = ledger.task.leaseTask(task.id, { owner: 'w', ttlMs: 60_000, now: at })!
  ledger.task.failTask(task.id, leased.fence, 'boom', { owner: 'w' })
  return task
}

function leased(ledger: Ledger, projectId: string, at: number, ttlMs = 1000) {
  const task = ledger.task.createTask({ projectId, spec: 'leased work', now: at })
  ledger.task.leaseTask(task.id, { owner: 'w', ttlMs, now: at })
  return task
}

function rowCounts(db: ReturnType<typeof fixture>['db']): string {
  const tables = ['task', 'approval', 'decision', 'memory', 'memory_event', 'event']
  return tables
    .map((table) => `${table}=${Number(allRows(db, `SELECT COUNT(*) AS n FROM ${table}`)[0]?.['n'] ?? 0)}`)
    .join(',')
}

test('inbox groups needs_you, review, and broken states with actionable ids', () => {
  const { db, ledger } = fixture()
  blocked(ledger, 'p1', T0 + 10, 'needs a decision on schema')
  claimed(ledger, 'p1', T0 + 20)
  suspect(ledger, 'p1', T0 + 30)
  failed(ledger, 'p1', T0 + 40)
  const stale = leased(ledger, 'p1', T0 + 50, 1000)
  ledger.approval.requestApproval({
    projectId: 'p1', kind: 'git.push', request: { branch: 'main' }, ttlMs: 60_000,
  })

  const signal = { now: T0 + 10_000 }
  const result = buildInbox(db, 'p1', signal)
  expect(result.total).toBe(6)
  expect(result.items.length).toBe(6)
  const order = result.items.map((item) => `${item.category}:${item.kind}`).join(',')
  expect(order).toBe(
    'needs_you:approval,needs_you:task,review:task,review:task,broken:task,broken:lease'
  )
  const approval = result.items[0]!
  expect(approval.title).toBe('Approval: git.push')
  expect(approval.projectName).toBe('Alpha')
  expect(approval.evidenceSummary).toContain('main')
  expect(approval.ageMs).toBe(T0 + 10_000 - T0)

  const blockedItem = result.items[1]!
  expect(blockedItem.title).toBe('needs a decision on schema')
  expect(blockedItem.evidenceSummary).toBe('no evidence')
  const claimedItem = result.items[2]!
  expect(claimedItem.status).toBe('claimed_done')
  expect(claimedItem.evidenceSummary).toContain('bun test')
  expect(result.items[5]!.id).toBe(stale.id)
  expect(result.items[5]!.status).toBe('leased')

  const counts = inboxCounts(db, 'p1', signal)
  expect(`${counts.needsYou},${counts.review},${counts.broken},${counts.total}`).toBe('2,2,2,6')
})

test('stale leases are detected only after the injected clock passes expiry', () => {
  const { db, ledger } = fixture()
  leased(ledger, 'p1', T0, 1000)
  expect(buildInbox(db, 'p1', { now: T0 + 999 }).items.length).toBe(0)
  const after = buildInbox(db, 'p1', { now: T0 + 1000 })
  expect(after.items.length).toBe(1)
  expect(after.items[0]!.kind).toBe('lease')
  expect(after.items[0]!.category).toBe('broken')
})

test('expired pending approvals leave needs_you without being mutated', () => {
  const { db, ledger } = fixture()
  const challenge = ledger.approval.requestApproval({
    projectId: 'p1', kind: 'deploy', request: { target: 'prod' }, ttlMs: 60_000,
  })
  expect(buildInbox(db, 'p1', { now: T0 + 1000 }).total).toBe(1)
  expect(buildInbox(db, 'p1', { now: T0 + 120_000 }).total).toBe(0)
  // The projection hides the expired approval but leaves the row for the sweeper.
  const row = allRows(db, 'SELECT status FROM approval WHERE id = ?', challenge.id)[0]
  expect(row?.['status']).toBe('pending')
})

test('building the inbox and counts never writes a row', () => {
  const { db, ledger } = fixture()
  blocked(ledger, 'p1', T0 + 1)
  claimed(ledger, 'p1', T0 + 2)
  failed(ledger, 'p1', T0 + 3)
  leased(ledger, 'p1', T0 + 4, 10)
  ledger.approval.requestApproval({
    projectId: 'p1', kind: 'delete', request: { id: 'x' }, ttlMs: 60_000,
  })
  const before = rowCounts(db)
  buildInbox(db, 'p1', { now: T0 + 10_000 })
  buildInbox(db, undefined, { now: T0 + 10_000, limit: 2 })
  inboxCounts(db, 'p1', { now: T0 + 10_000 })
  expect(rowCounts(db)).toBe(before)
})

test('pagination is stable and project is a facet, not a tab', () => {
  const { db, ledger } = fixture()
  for (let i = 0; i < 5; i += 1) blocked(ledger, 'p1', T0 + i, `task-${i}`)
  blocked(ledger, 'p2', T0 + 100, 'other project')

  const page1 = buildInbox(db, 'p1', { now: T0 + 200, limit: 2, offset: 0 })
  const page2 = buildInbox(db, 'p1', { now: T0 + 200, limit: 2, offset: 2 })
  const page3 = buildInbox(db, 'p1', { now: T0 + 200, limit: 2, offset: 4 })
  expect(page1.total).toBe(5)
  expect(page1.items.map((item) => item.title).join(',')).toBe('task-0,task-1')
  expect(page2.items.map((item) => item.title).join(',')).toBe('task-2,task-3')
  expect(page3.items.map((item) => item.title).join(',')).toBe('task-4')
  // Rebuilding the same page yields the identical order (no unstable tie-break).
  expect(buildInbox(db, 'p1', { now: T0 + 200, limit: 2, offset: 0 }).items
    .map((item) => item.id).join(',')).toBe(page1.items.map((item) => item.id).join(','))

  expect(buildInbox(db, 'p2', { now: T0 + 200 }).total).toBe(1)
  expect(buildInbox(db, undefined, { now: T0 + 200 }).total).toBe(6)
})

test('approval decisions and task verdicts are reflected in counts and status', () => {
  const { db, ledger } = fixture()
  const at = T0 + 1000
  // [needsYou, review, broken, total] — bun:test's matcher types have no toMatchObject.
  const counts = () => {
    const n = inboxCounts(db, 'p1', { now: at })
    return [n.needsYou, n.review, n.broken, n.total]
  }
  const link = (task: { id: string }) => {
    const fence = ledger.task.getTask(task.id)!.fence
    const challenge = ledger.approval.requestApproval({
      projectId: 'p1', kind: 'task', taskId: task.id,
      request: { taskId: task.id, fence }, ttlMs: 60_000,
    })
    return { fence, challenge }
  }

  const approved = claimed(ledger, 'p1', T0 + 1)
  expect(counts().join(',')).toBe('0,1,0,1')
  const first = link(approved)
  expect(counts().join(',')).toBe('1,1,0,2')

  ledger.approval.decideApproval(first.challenge.id, {
    actor: 'human', approve: true, digest: first.challenge.digest, nonce: first.challenge.nonce,
  })
  // Approved-but-unconsumed consent leaves "needs you"; the task still awaits its verdict.
  expect(counts().join(',')).toBe('0,1,0,1')

  expect(ledger.approval.consumeApproval(first.challenge.id, { digest: first.challenge.digest })).toBe(true)
  ledger.task.verifyTask(approved.id, first.fence, null, { actor: 'human' })
  expect(counts().join(',')).toBe('0,0,0,0')
  expect(ledger.task.getTask(approved.id)?.status).toBe('verified')

  const rejected = claimed(ledger, 'p1', T0 + 2)
  const second = link(rejected)
  ledger.approval.decideApproval(second.challenge.id, {
    actor: 'human', approve: false, digest: second.challenge.digest, nonce: second.challenge.nonce,
  })
  ledger.task.failTask(rejected.id, second.fence, 'rejected by human review', { actor: 'human' })
  expect(counts().join(',')).toBe('0,0,1,1')
})
