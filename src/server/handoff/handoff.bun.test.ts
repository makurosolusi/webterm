// Bun-only (bun:sqlite): handoff cards over a real ledger. Evidence comes from the ledger and ignores the
// numbers a model claims; the narrative falls back on a bad answer or timeout; Continue injects each card
// exactly once (outbox operationId); the HTTP route. The model is always a fake.
import { expect, test } from 'bun:test'
import { insertCostUsage } from '../cost/costStore'
import { createEventLog } from '../events/eventLog'
import { openLedgerDb } from '../ledger/migration'
import { createOutboxStore } from '../outbox/outboxStore'
import type { StructuredCall } from '../central/context/claudeStructured'
import type { Workspace } from '../../shared/workspace'
import { latestCard } from './handoff.store'
import { buildCard, continueWorkspace, type ContinueDeps } from './handoff.service'
import { HANDOFF_CONTINUE_PATH, HANDOFF_PATH, handoffRoute, tailWithin } from './handoff.route'
import { renderCardForAgent } from './handoff.model'

const T0 = 1_700_000_000_000
const WS: Workspace = {
  id: 'ws1', name: 'Repo', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: T0,
  nodes: [
    { id: 'n1', kind: 'agent', x: 0, y: 0, agentId: 'claude', sessionId: '11111111-1111-4111-8111-111111111111', title: 'brisk-otter' },
    { id: 'n2', kind: 'terminal', x: 0, y: 0 },
  ],
}
const NARRATIVE = { summary: 'Auth refactor half done.', done: ['split token store'], openQuestions: ['keep v1 API?'], nextSteps: ['run e2e'] }

function fixture(narrate: StructuredCall = async () => NARRATIVE) {
  const db = openLedgerDb(':memory:')
  const clock = { t: T0 }
  const log = createEventLog(db, { now: () => clock.t })
  const outbox = createOutboxStore(db, () => clock.t)
  const deps: ContinueDeps = {
    db, log, now: () => clock.t, narrate,
    transcript: async () => ['user: refactor auth', 'assistant: split the token store, e2e next'],
    mask: (lines) => lines.join('\n'),
    enqueue: (input) => outbox.enqueue(input),
    refusal: () => null,
    timeoutMs: 50,
  }
  const event = (kind: string, payload: unknown = {}, nodeId = 'n1') => log.append({ kind, source: 'test', nodeId, workspaceId: 'ws1', trust: 'trusted', payload })
  return { db, clock, log, outbox, deps, event }
}

function seedEvidence(f: ReturnType<typeof fixture>): void {
  f.clock.t = T0 + 10
  f.event('hook.Stop')
  f.event('hook.Stop', {}, 'n1:p2') // a pane of the same node
  f.event('verifier.verdict', {
    taskId: 't1', status: 'done', summary: '2 files, tests green ✓',
    receipt: { evidence: { filesChanged: 2, diffStat: '2 files changed, 10 insertions(+)', commands: [{ command: 'npm test', exitCode: 0 }, { command: 'npm run typecheck', exitCode: 0 }] } },
  })
  insertCostUsage(f.db, { key: 'k1', ts: T0 + 11, source: 'agent', workspaceId: 'ws1', nodeId: 'n1', sessionId: null, model: 'claude-x', input: 1, output: 1, cacheRead: 0, write5m: 0, write1h: 0, costMicros: 120_000 })
  f.clock.t = T0 + 100
}

test('evidence comes from the ledger; numbers the model claims are ignored', async () => {
  const lying: StructuredCall = async () => ({ ...NARRATIVE, filesChanged: 99, costMicros: 0, checks: [{ command: 'npm test', exitCode: 0 }], turns: 50 })
  const f = fixture(lying)
  seedEvidence(f)
  const card = await buildCard(f.deps, WS, WS.nodes[0]!)
  expect(card.narrativeSource).toBe('model')
  expect(card.narrative).toEqual(NARRATIVE)
  expect(card.evidence).toMatchObject({
    turns: 2, filesChanged: 2, diffStat: '2 files changed, 10 insertions(+)', costMicros: 120_000,
    checks: [{ command: 'npm test', exitCode: 0 }, { command: 'npm run typecheck', exitCode: 0 }],
    receipts: [{ taskId: 't1', status: 'done', summary: '2 files, tests green ✓' }],
  })
  expect(Object.keys(card.narrative)).toEqual(['summary', 'done', 'openQuestions', 'nextSteps']) // claimed keys dropped
  expect(latestCard(f.db, 'n1')?.id).toBe(card.id)
  const text = renderCardForAgent(card)
  expect(text).toContain('Evidence recorded by webterm (not by the agent):')
  expect(text).toContain('- Files changed: 2 (2 files changed, 10 insertions(+))')
  expect(text).toContain('- Cost: $0.12')
})

test('no verifier record = "not verified", never a guess', async () => {
  const f = fixture()
  const card = await buildCard(f.deps, WS, WS.nodes[0]!)
  expect(card.evidence).toMatchObject({ turns: 0, filesChanged: null, diffStat: null, checks: [], receipts: [], costMicros: null })
  expect(renderCardForAgent(card)).toContain('- Files changed: not verified')
})

test('narrative falls back on an off-schema answer, a failure and a timeout', async () => {
  const answers: StructuredCall[] = [
    async () => ({ summary: 42 }),
    async () => { throw new Error('claude exited 1') },
    (_r, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  ]
  for (const narrate of answers) {
    const card = await buildCard(fixture(narrate).deps, WS, WS.nodes[0]!)
    expect(card.narrativeSource).toBe('fallback')
    expect(card.narrative.summary).toBe('Last reply: split the token store, e2e next')
  }
})

test('continue injects each card exactly once and only into agent nodes', async () => {
  let calls = 0
  const f = fixture(async () => { calls += 1; return NARRATIVE })
  seedEvidence(f)
  const first = await continueWorkspace(f.deps, WS)
  expect(first).toHaveLength(1)
  expect(first[0]).toMatchObject({ nodeId: 'n1', injected: true })
  const queued = f.outbox.queued('n1', 'context')
  expect(queued).toHaveLength(1)
  expect(queued[0]!.body).toContain('Summary: Auth refactor half done.')
  // Second click, nothing happened since: same card, no new delivery, no new model call.
  const again = await continueWorkspace(f.deps, WS)
  expect(again[0]).toMatchObject({ cardId: first[0]!.cardId, injected: false })
  expect(f.outbox.list('n1')).toHaveLength(1)
  expect(calls).toBe(1)
  // New activity after the card: a fresh card, delivered once more.
  f.clock.t = T0 + 200
  f.event('hook.Stop')
  f.clock.t = T0 + 300
  const later = await continueWorkspace(f.deps, WS)
  expect(later[0]!.cardId).not.toBe(first[0]!.cardId)
  expect(later[0]!.injected).toBe(true)
  expect(f.outbox.list('n1')).toHaveLength(2)
  expect(latestCard(f.db, 'n1')?.evidence.since).toBe(T0 + 100)
})

test('route: list cards per workspace, continue, validation', async () => {
  const f = fixture()
  const deps = { deps: f.deps, workspaces: () => [WS] }
  const body = (s: string) => async () => s
  expect(await handoffRoute('/api/other', 'GET', body(''), deps)).toBeNull()
  expect((await handoffRoute(HANDOFF_PATH, 'POST', body(''), deps))?.status).toBe(405)
  const before = await handoffRoute(HANDOFF_PATH, 'GET', body(''), deps)
  expect(before?.body).toEqual({ workspaces: [{ id: 'ws1', name: 'Repo', agents: [{ nodeId: 'n1', title: 'brisk-otter', card: null }] }] })
  expect((await handoffRoute(HANDOFF_CONTINUE_PATH, 'POST', body('nope'), deps))?.status).toBe(400)
  expect((await handoffRoute(HANDOFF_CONTINUE_PATH, 'POST', body('{"workspaceId":"zz"}'), deps))?.status).toBe(404)
  const res = await handoffRoute(HANDOFF_CONTINUE_PATH, 'POST', body('{"workspaceId":"ws1"}'), deps)
  expect(res?.status).toBe(200)
  expect((res?.body as { results: Array<{ injected: boolean }> }).results[0]?.injected).toBe(true)
  const after = await handoffRoute(HANDOFF_PATH, 'GET', body(''), deps)
  expect((after?.body as { workspaces: Array<{ agents: Array<{ card: unknown }> }> }).workspaces[0]?.agents[0]?.card).not.toBeNull()
})

test('tailWithin keeps the newest lines that fit', () => {
  expect(tailWithin(['aaaa', 'bb', 'cc'], 6)).toEqual(['bb', 'cc'])
})
