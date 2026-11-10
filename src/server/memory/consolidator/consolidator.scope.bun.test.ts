// Bun-only (bun:sqlite). A proposal belongs to the project of the node it came from: stored with that id,
// served only there, kept when confirmed; a node on no board stays global. The model is always a fake.
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { proceduralBlock } from '../../awareness/proceduralMemory'
import { registerWorkspaceLookup, type WorkspaceRecord } from '../../central/workspaceLookup'
import { buildMemoryBlock } from '../memoryBlock'
import { searchMemoryHybrid } from '../memoryHybrid'
import { T0, fixture, seedRow } from '../memoryV2.fixture'
import type { ProposedOp } from './consolidator.model'
import type { ConsolidatorModel } from './consolidator.runner'
import { consolidateNode } from './consolidator.runtime'
import { confirmConsolidatorProposal, knownMemories, listConsolidatorProposals, writeProposals } from './consolidator.store'

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'consolidator-scope-'))
const prevDir = process.env.WEBTERM_DATA_DIR
process.env.WEBTERM_DATA_DIR = root // transcripts must sit under an allowed root (transcriptPath.ts)

const boards: WorkspaceRecord[] = [
  { id: 'w1', name: 'Alpha', cwd: '/tmp/a', nodes: [{ id: 'a1' }] },
  { id: 'w2', name: 'Beta', cwd: '/tmp/b', nodes: [{ id: 'b1' }] },
]
let unregister: () => void = () => {}
beforeEach(() => { unregister = registerWorkspaceLookup((id) => boards.find((b) => b.id === id) ?? null, () => boards) })
afterEach(() => unregister())
afterAll(() => {
  if (prevDir === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prevDir
  rmSync(root, { recursive: true, force: true })
})

const HUMAN = { kind: 'human' as const, id: 'human-ui' }
const LESSON = 'The zebrafish build needs the gamma toolchain'
const add = (text: string, kind: ProposedOp['kind'] = 'fact'): ProposedOp => ({ op: 'add', kind, text, targetId: null })
const projectOf = (db: Database, id: string): unknown => (db.query('SELECT project_id FROM memory WHERE id = ?').get(id) as { project_id: unknown }).project_id
const served = (db: Database, projectId: string | null): string[] =>
  searchMemoryHybrid(db, { viewer: { projectId }, query: 'zebrafish gamma toolchain', now: T0 + 1, embedder: null }).map((h) => h.record.body)

function transcript(): string {
  const path = join(root, `t-${Math.random().toString(36).slice(2)}.jsonl`)
  writeFileSync(path, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }))
  return path
}

const model = (ops: ProposedOp[]): ConsolidatorModel => async () =>
  ({ output: { ops }, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, costMicros: 1, model: 'claude-haiku-test' } })

async function propose(db: Database, nodeId: string, op: ProposedOp, workspaceId?: string): Promise<string> {
  const deps = { db: () => db, transcriptOf: () => transcript(), model: model([op]), now: () => T0 }
  const out = await consolidateNode(deps, new Map(), nodeId, null, workspaceId)
  expect(out.status).toBe('ok')
  expect(out.written.length).toBe(1)
  return out.written[0]!
}

test('a proposal from a node in project A is stored with A and still lists as pending', async () => {
  const db = fixture()
  const id = await propose(db, 'a1', add(LESSON))
  expect(projectOf(db, id)).toBe('p1')
  expect(listConsolidatorProposals(db).map((p) => p.id)).toEqual([id])
})

test('retrieval for project B does not return a project A proposal; A does; the global conversation does not', async () => {
  const db = fixture()
  await propose(db, 'a1', add(LESSON))
  expect(served(db, 'p2')).toEqual([])
  expect(served(db, 'p1')).toEqual([LESSON])
  expect(served(db, null)).toEqual([])
})

test('the memory block of project B stays free of the lesson; project A carries it', async () => {
  const db = fixture()
  await propose(db, 'a1', add(LESSON))
  const block = (conversationId: string): string =>
    buildMemoryBlock(db, { conversationId, projectId: null, query: 'zebrafish gamma toolchain', maxTokens: 500 }, { now: () => T0 + 1 }).text
  expect(block('central:project:p2')).not.toContain(LESSON)
  expect(block('central:project:p1')).toContain(LESSON)
})

test('confirmed: an add keeps its project, as does a project procedure, which stays out of every session block', async () => {
  const db = fixture()
  const fact = await propose(db, 'a1', add(LESSON))
  confirmConsolidatorProposal(db, HUMAN, fact, T0 + 1)
  expect(db.query('SELECT status, project_id FROM memory WHERE id = ?').get(fact)).toEqual({ status: 'fact', project_id: 'p1' })
  expect(served(db, 'p2')).toEqual([])
  expect(served(db, 'p1')).toEqual([LESSON])

  const rule = await propose(db, 'a1', add('Always run the gamma linter', 'procedure'))
  const { resultId } = confirmConsolidatorProposal(db, HUMAN, rule, T0 + 2)
  expect(projectOf(db, resultId)).toBe('p1')
  expect(proceduralBlock(db)).toBe('')
})

test('confirmed update of a project memory stays in that project', async () => {
  const db = fixture()
  const target = seedRow(db, { key: 'a.toolchain', body: 'the toolchain is alpha', scope: 'central', projectId: 'p1' })
  const [id] = writeProposals(db, [{ op: 'update', kind: 'fact', text: LESSON, targetId: target }], { nodeId: 'a1', sourceEventId: null, projectId: 'p1' }, T0).written
  expect(projectOf(db, confirmConsolidatorProposal(db, HUMAN, id!, T0 + 1).resultId)).toBe('p1')
})

test('an unresolved node stays global', async () => {
  const db = fixture()
  const id = await propose(db, 'gone', add(LESSON))
  expect(projectOf(db, id)).toBeNull()
  expect(served(db, 'p2')).toEqual([LESSON])
})

test('a node already removed from its board still resolves through the workspace its hooks reported', async () => {
  const db = fixture()
  expect(projectOf(db, await propose(db, 'closed', add(LESSON), 'w2'))).toBe('p2')
})

test('the same lesson can be proposed in two projects; a global row already covers both', () => {
  const db = fixture()
  expect(writeProposals(db, [add(LESSON)], { nodeId: 'a1', sourceEventId: null, projectId: 'p1' }, T0).written.length).toBe(1)
  expect(writeProposals(db, [add(LESSON)], { nodeId: 'b1', sourceEventId: null, projectId: 'p2' }, T0).written.length).toBe(1)
  const db2 = fixture()
  writeProposals(db2, [add(LESSON)], { nodeId: null, sourceEventId: null }, T0)
  expect(writeProposals(db2, [add(LESSON)], { nodeId: 'a1', sourceEventId: null, projectId: 'p1' }, T0).skipped[0]?.code).toBe('duplicate')
})

test('the model reviewing project B is never shown project A memories', () => {
  const db = fixture()
  const own = seedRow(db, { key: 'a.secret', body: 'alpha internal', scope: 'central', projectId: 'p1' })
  const shared = seedRow(db, { key: 'g.x', body: 'shared' })
  expect(knownMemories(db, 'p2').map((m) => m.id)).toEqual([shared])
  expect(knownMemories(db, 'p1').map((m) => m.id).sort()).toEqual([own, shared].sort())
})
