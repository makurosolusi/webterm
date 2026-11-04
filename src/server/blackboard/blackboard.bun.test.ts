// Bun-only (bun:sqlite). F5-b shared blackboard: who may write which key, proposals + human confirm/reject,
// history, the awareness summary, the HTTP gate (UI / node token / anonymous) and the Central tools.
import { expect, test } from 'bun:test'
import type { IncomingMessage } from 'node:http'
import { writeProposals } from '../memory/consolidator/consolidator.store'
import { forgetMemory, listMemoryItems, setIncognito } from '../memory/memoryControls'
import { searchMemoryHybrid } from '../memory/memoryHybrid'
import { MemoryAuthorityError, MemoryRejectedError } from '../memory/memoryModel'
import { T0, fixture } from '../memory/memoryV2.fixture'
import { BLACKBOARD_PATH, handleBlackboardApi } from './blackboard.api'
import { BLACKBOARD_DEFS } from './blackboard.defs'
import {
  BLACKBOARD_SUMMARY_HEADER, blackboardHistory, blackboardSummary, confirmProposal, listBlackboard, listProposals, rejectProposal, writeBlackboard,
} from './blackboard.store'

const HUMAN = { kind: 'human' as const, id: 'human-ui' }
const A1 = { kind: 'agent' as const, nodeId: 'a1' }
const A2 = { kind: 'agent' as const, nodeId: 'a2' }
const codeOf = (fn: () => unknown): string => {
  try { fn() } catch (err) { return err instanceof MemoryRejectedError ? err.code : err instanceof MemoryAuthorityError ? 'authority' : `other:${String(err)}` }
  return 'none'
}
const values = (db: ReturnType<typeof fixture>) => listBlackboard(db).map((e) => `${e.key}=${e.value}`)

test('a human writes any key; an agent writes only its own agent:<id> keys, everything else becomes a proposal', () => {
  const db = fixture()
  expect(writeBlackboard(db, HUMAN, 'goal:auth/status', 'in progress', T0).proposed).toBe(false)
  expect(writeBlackboard(db, A1, 'agent:a1/focus', 'writing the login form', T0 + 1).proposed).toBe(false)
  const p = writeBlackboard(db, A1, 'goal:auth/status', 'done', T0 + 2)
  expect(p.proposed).toBe(true)
  // Another node's namespace is not "own": a proposal too.
  expect(writeBlackboard(db, A2, 'agent:a1/focus', 'hijacked', T0 + 3).proposed).toBe(true)
  expect(values(db)).toEqual(['agent:a1/focus=writing the login form', 'goal:auth/status=in progress'])
  expect(listProposals(db).map((e) => [e.key, e.value, e.by])).toEqual([['goal:auth/status', 'done', 'node:a1'], ['agent:a1/focus', 'hijacked', 'node:a2']])
  // The same proposal twice is one row; the same value as the current one is a no-op.
  expect(writeBlackboard(db, A1, 'goal:auth/status', 'done', T0 + 4)).toMatchObject({ proposed: true, unchanged: true })
  expect(writeBlackboard(db, HUMAN, 'goal:auth/status', 'in progress', T0 + 4).unchanged).toBe(true)
  expect(listProposals(db).length).toBe(2)
  expect(codeOf(() => writeBlackboard(db, HUMAN, 'no namespace', 'x', T0))).toBe('invalid_key')
  expect(codeOf(() => writeBlackboard(db, HUMAN, 'goal:x', 'sk-CANARY0123456789abcdefghij', T0))).toBe('secret_detected')
  expect(codeOf(() => writeBlackboard(db, HUMAN, 'goal:x', 'x'.repeat(501), T0))).toBe('too_long')
})

test('confirm makes a proposal current and keeps the old value in history; reject quarantines; agents cannot do either', () => {
  const db = fixture()
  writeBlackboard(db, HUMAN, 'goal:auth/status', 'in progress', T0)
  const p = writeBlackboard(db, A1, 'goal:auth/status', 'done', T0 + 1).entry
  const q = writeBlackboard(db, A2, 'decision:db-engine', 'mysql', T0 + 2).entry
  expect(codeOf(() => confirmProposal(db, A1, p.id, T0 + 3))).toBe('authority')
  expect(confirmProposal(db, HUMAN, p.id, T0 + 3).status).toBe('fact')
  expect(rejectProposal(db, HUMAN, q.id, T0 + 4).status).toBe('quarantine')
  expect(codeOf(() => confirmProposal(db, HUMAN, q.id, T0 + 5))).toBe('not_pending')
  expect(values(db)).toEqual(['goal:auth/status=done'])
  expect(blackboardHistory(db, 'goal:auth/status').map((e) => [e.value, e.status, e.by])).toEqual([
    ['done', 'fact', 'node:a1'], ['in progress', 'superseded', 'human-ui'],
  ])
  expect(blackboardHistory(db, 'decision:db-engine').map((e) => e.status)).toEqual(['quarantine'])
  // A direct overwrite also leaves history.
  writeBlackboard(db, HUMAN, 'goal:auth/status', 'reopened', T0 + 6)
  expect(blackboardHistory(db, 'goal:auth/status').map((e) => e.value)).toEqual(['reopened', 'done', 'in progress'])
})

test('forgetting a proposal leaves the current value alone; the blackboard never leaks into memory retrieval', () => {
  const db = fixture()
  writeBlackboard(db, HUMAN, 'goal:auth/status', 'in progress', T0)
  const p = writeBlackboard(db, A1, 'goal:auth/status', 'blocked on review', T0 + 1).entry
  forgetMemory(db, HUMAN, p.id, T0 + 2)
  expect(values(db)).toEqual(['goal:auth/status=in progress'])
  // Forgotten = tombstoned: the same proposal is refused, but a different key with a short value is not affected.
  expect(codeOf(() => writeBlackboard(db, A1, 'goal:auth/status', 'blocked on review', T0 + 3))).toBe('forgotten')
  expect(searchMemoryHybrid(db, { viewer: { projectId: null }, query: 'progress', now: T0 + 4 }).length).toBe(0)
})

test('"Everything remembered" leaves blackboard rows out; consolidator proposals stay, labelled as claims', () => {
  const db = fixture()
  writeBlackboard(db, HUMAN, 'goal:auth/status', 'in progress', T0)
  writeBlackboard(db, A1, 'goal:auth/status', 'done', T0 + 1)
  writeProposals(db, [{ op: 'add', kind: 'preference', text: 'The user prefers tabs', targetId: null }], { nodeId: 'a1', sourceEventId: null }, T0 + 2)
  const items = listMemoryItems(db, T0 + 3)
  expect(items.map((i) => [i.text, i.status])).toEqual([['The user prefers tabs', 'claim']])
  expect(listMemoryItems(db, T0 + 3, 'semantic').some((i) => i.scope === 'blackboard')).toBe(false)
})

test('an incognito node writes nothing to the board', () => {
  const db = fixture()
  setIncognito(db, HUMAN, 'node:a1', true, T0)
  expect(codeOf(() => writeBlackboard(db, A1, 'agent:a1/focus', 'secret plan', T0 + 1))).toBe('incognito')
})

test('summary lists current values newest first under the header and fits the budget', () => {
  const db = fixture()
  expect(blackboardSummary(db)).toBe('')
  writeBlackboard(db, HUMAN, 'goal:auth/status', 'in progress', T0)
  writeBlackboard(db, HUMAN, 'decision:db-engine', 'postgres', T0 + 1)
  writeBlackboard(db, A1, 'goal:ui/status', 'proposal only', T0 + 2)
  expect(blackboardSummary(db)).toBe([BLACKBOARD_SUMMARY_HEADER, '- decision:db-engine: postgres', '- goal:auth/status: in progress'].join('\n'))
  expect(blackboardSummary(db, BLACKBOARD_SUMMARY_HEADER.length + 35)).toBe([BLACKBOARD_SUMMARY_HEADER, '- decision:db-engine: postgres'].join('\n'))
})

test('HTTP: the UI and proven nodes read; a node writes as itself; only the UI confirms; anonymous callers get 403', () => {
  const db = fixture()
  const ui = { host: '127.0.0.1:8700', origin: 'http://127.0.0.1:8700', 'sec-fetch-site': 'same-origin' }
  const node = { 'x-webterm-token': 'tok-a1' }
  const call = (method: string, headers: Record<string, string>, path = BLACKBOARD_PATH, body?: unknown) =>
    handleBlackboardApi({ method, headers } as unknown as IncomingMessage, new URL(`http://127.0.0.1:8700${path}`), body, {
      db, isNodeToken: (t) => t === 'tok-a1', nodeOf: (req) => (req.headers['x-webterm-token'] === 'tok-a1' ? 'a1' : undefined), now: () => T0,
    })
  expect(call('GET', { host: '127.0.0.1:8700' })?.status).toBe(403)
  expect(call('POST', ui, BLACKBOARD_PATH, { key: 'goal:auth/status', value: 'in progress' })?.body).toMatchObject({ proposed: false })
  const proposed = call('POST', node, BLACKBOARD_PATH, { key: 'goal:auth/status', value: 'done' })
  expect(proposed?.body).toMatchObject({ proposed: true, entry: { by: 'node:a1' } })
  expect(call('POST', node, BLACKBOARD_PATH, { key: 'agent:a1/focus', value: 'tests' })?.body).toMatchObject({ proposed: false })
  const read = call('GET', node)?.body as { entries: unknown[]; proposals: Array<{ id: string }> }
  expect(read.entries.length).toBe(2)
  const pid = read.proposals[0]!.id
  expect(call('POST', node, `${BLACKBOARD_PATH}/proposals/${pid}/confirm`)?.status).toBe(403)
  expect(call('POST', ui, `${BLACKBOARD_PATH}/proposals/${pid}/confirm`)?.status).toBe(200)
  const history = call('GET', node, `${BLACKBOARD_PATH}/history?key=${encodeURIComponent('goal:auth/status')}`)?.body as { history: Array<{ value: string }> }
  expect(history.history.map((h) => h.value)).toEqual(['done', 'in progress'])
  expect(call('GET', ui, `${BLACKBOARD_PATH}/history?key=bad`)?.status).toBe(400)
  expect(call('POST', ui, `${BLACKBOARD_PATH}/proposals/nope/confirm`)?.status).toBe(404)
  expect(call('DELETE', ui)?.status).toBe(405)
  expect(call('GET', ui, '/api/blackboardx')).toBeNull()
})

test('Central tools: read returns entries or history; propose is always a proposal', async () => {
  const db = fixture()
  writeBlackboard(db, HUMAN, 'goal:auth/status', 'in progress', T0)
  const [read, propose] = BLACKBOARD_DEFS
  const ctx = { db, conversationId: 'central:global', now: () => T0 + 1 } as unknown as Parameters<NonNullable<typeof read>['handler']>[0]
  expect(read!.validate({ key: 'goal:auth/status', extra: 1 }, ctx)).toBe('invalid_shape')
  expect((await read!.handler(ctx, {}, undefined)).data).toMatchObject({ count: 1 })
  expect((await propose!.handler(ctx, { key: 'goal:auth/status', value: 'done' }, undefined)).data).toMatchObject({ proposed: true })
  expect(values(db)).toEqual(['goal:auth/status=in progress'])
  expect((await read!.handler(ctx, { key: 'goal:auth/status' }, undefined)).data).toMatchObject({ count: 2 })
})
