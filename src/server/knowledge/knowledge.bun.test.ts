// Bun-only: real git fixture repo, real bun:sqlite knowledge.db + ledger.
import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allRows } from '../ledger/ledgerCore'
import { BRIEF_MAX_TOKENS, buildBrief, createKnowledgePort, evaluateAttention, fitBrief, type BriefSnapshot } from './knowledgeBrief'
import { checkFreshness, ensureFresh, refreshIndex } from './knowledgeFresh'
import { moduleMap, resolveImport, searchKb } from './knowledgeMap'
import { isExcludedPath } from './knowledgeScan'
import { getKbProject, openKnowledgeDb } from './knowledgeStore'
import { FIXTURE_SECRET, NOW, makeLedger, makeRepo, put, sh } from './knowledgeFixture.testutil'
import { estimateTokens } from '../central/tools/toolRegistry'
import type { ProjectBrief } from '../central/contracts/knowledge.types'

const dump = (db: ReturnType<typeof openKnowledgeDb>): string =>
  JSON.stringify([allRows(db, 'SELECT * FROM kb_file'), allRows(db, 'SELECT path, heading, text FROM kb_doc')])

test('map: in-degree from relative imports, ordered by importance', async () => {
  const root = makeRepo()
  const kb = openKnowledgeDb(':memory:')
  await refreshIndex(kb, 'p1', root, NOW)
  const files = allRows(kb, "SELECT path, in_degree FROM kb_file WHERE project_id = 'p1' AND path LIKE 'src/%'")
  const deg = Object.fromEntries(files.map((r) => [String(r.path), Number(r.in_degree)]))
  expect(deg['src/b.ts']).toBe(2) // a.ts and c.ts (`./b.js` resolves to b.ts)
  expect(deg['src/a.ts']).toBe(0)
  const mods = moduleMap(kb, 'p1')
  expect(mods[0]?.dir).toBe('src')
  expect(mods[0]?.inDegree).toBe(2)
  expect(mods[0]?.summary).toContain('b.ts(in 2: BETA,shared)')
  expect(resolveImport('src/a.ts', './b', new Set(['src/b.ts']))).toBe('src/b.ts')
  expect(resolveImport('src/a.ts', 'react', new Set(['src/b.ts']))).toBe(null)
  rmSync(root, { recursive: true, force: true })
})

test('search: docs by heading and exported names; hostile query cannot break FTS', async () => {
  const root = makeRepo()
  const kb = openKnowledgeDb(':memory:')
  await refreshIndex(kb, 'p1', root, NOW)
  const docs = searchKb(kb, 'p1', 'zebraquokka subsystem', 5)
  expect(docs[0]?.path).toBe('README.md')
  expect(docs[0]?.title).toBe('Zebraquokka')
  expect(docs[0]?.snippet).toContain('[zebraquokka]')
  expect(searchKb(kb, 'p1', 'alpha', 5)[0]?.path).toBe('src/a.ts')
  expect(searchKb(kb, 'p1', '"; DROP TABLE kb_file; -- OR *', 5).length).toBe(0)
  expect(searchKb(kb, 'p1', '   ', 5).length).toBe(0)
  expect(searchKb(kb, 'other-project', 'zebraquokka', 5).length).toBe(0)
  rmSync(root, { recursive: true, force: true })
})

test('secrets: .env*, keys, node_modules and dist are never indexed; docs are redacted', async () => {
  const root = makeRepo()
  const kb = openKnowledgeDb(':memory:')
  await refreshIndex(kb, 'p1', root, NOW)
  const paths = allRows(kb, 'SELECT path FROM kb_file').map((r) => String(r.path))
  for (const bad of ['.env', '.env.local', 'config/server.pem', 'node_modules/dep/index.js', 'dist/out.js']) expect(paths.includes(bad)).toBe(false)
  expect(paths.includes('src/a.ts')).toBe(true)
  const all = dump(kb)
  expect(all.includes(FIXTURE_SECRET)).toBe(false)
  expect(all.includes('depSymbol')).toBe(false)
  expect(searchKb(kb, 'p1', 'depSymbol', 5).length).toBe(0)
  expect(isExcludedPath('a/.env.production')).toBe(true)
  expect(isExcludedPath('a/b.PEM')).toBe(true)
  // an untracked .env created later is also skipped
  put(root, { '.env.new': `X=${FIXTURE_SECRET}\n`, 'src/d.ts': 'export const d = 1\n' })
  await refreshIndex(kb, 'p1', root, NOW + 1)
  expect(allRows(kb, "SELECT path FROM kb_file WHERE path = '.env.new'").length).toBe(0)
  expect(allRows(kb, "SELECT path FROM kb_file WHERE path = 'src/d.ts'").length).toBe(1)
  expect(dump(kb).includes(FIXTURE_SECRET)).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('stale: detected after a new commit and after a dirty edit; refresh clears it with new asOf', async () => {
  const root = makeRepo()
  const kb = openKnowledgeDb(':memory:')
  expect((await checkFreshness(kb, 'p1', root)).reason).toBe('never_indexed')
  const first = await ensureFresh(kb, 'p1', root, NOW)
  expect(first.stale).toBe(false)
  const sha1 = first.asOf.sha
  expect((await checkFreshness(kb, 'p1', root)).stale).toBe(false)

  put(root, { 'src/e.ts': 'export const eee = 1\n' })
  const dirty = await checkFreshness(kb, 'p1', root)
  expect(dirty.reason).toBe('dirty_changed')
  sh(root, 'add', '.')
  sh(root, 'commit', '-q', '-m', 'second')
  const lag = await checkFreshness(kb, 'p1', root)
  expect(lag.reason).toBe('head_changed')
  const noRefresh = await ensureFresh(kb, 'p1', root, NOW + 5, false)
  expect(noRefresh.stale).toBe(true)
  expect(noRefresh.asOf.sha).toBe(sha1)

  const second = await ensureFresh(kb, 'p1', root, NOW + 10)
  expect(second.stale).toBe(false)
  expect(second.asOf.at).toBe(NOW + 10)
  expect(second.asOf.sha === sha1).toBe(false)
  expect(searchKb(kb, 'p1', 'eee', 3)[0]?.path).toBe('src/e.ts')
  rmSync(root, { recursive: true, force: true })
})

test('incremental: unchanged files are not re-read, changed ones are', async () => {
  const root = makeRepo()
  const kb = openKnowledgeDb(':memory:')
  await refreshIndex(kb, 'p1', root, NOW)
  // Corrupt the stored exports of an unchanged file: a re-read would restore them.
  kb.query("UPDATE kb_file SET exports_json = '[\"sentinel\"]' WHERE path = 'src/c.ts'").run()
  put(root, { 'src/b.ts': 'export function shared() { return 1 }\nexport const BETA2 = 2\n' })
  await refreshIndex(kb, 'p1', root, NOW + 1)
  const exp = (p: string): string => String(allRows(kb, 'SELECT exports_json FROM kb_file WHERE path = ?', p)[0]?.exports_json)
  expect(exp('src/c.ts')).toBe('["sentinel"]')
  expect(exp('src/b.ts')).toContain('BETA2')
  rmSync(root, { recursive: true, force: true })
})

test('light mode: above the file cap only paths are stored, no graph', async () => {
  const root = makeRepo()
  const kb = openKnowledgeDb(':memory:')
  await refreshIndex(kb, 'p1', root, NOW, 3)
  const proj = getKbProject(kb, 'p1')
  expect(proj?.level).toBe('light')
  expect(allRows(kb, "SELECT path FROM kb_file WHERE exports_json != '[]' OR imports_json != '[]'").length).toBe(0)
  expect(allRows(kb, 'SELECT path FROM kb_file WHERE in_degree > 0').length).toBe(0)
  expect(moduleMap(kb, 'p1')[0]?.summary).toContain('files')
  expect(searchKb(kb, 'p1', 'zebraquokka', 3)[0]?.path).toBe('README.md') // docs still searchable
  await refreshIndex(kb, 'p1', root, NOW + 1) // back under the cap: full again, nothing reused from light
  expect(getKbProject(kb, 'p1')?.level).toBe('full')
  expect(allRows(kb, "SELECT path FROM kb_file WHERE exports_json != '[]'").length > 0).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('missing root and non-git dir do not crash; answers are labeled stale', async () => {
  const kb = openKnowledgeDb(':memory:')
  const gone = join(tmpdir(), 'kbfx-definitely-missing')
  const a = await ensureFresh(kb, 'p1', gone, NOW)
  expect(a.stale).toBe(true)
  expect(a.reason).toBe('not_git')
  const ledger = makeLedger(gone)
  const brief = await buildBrief(ledger, kb, 'p1', gone, NOW)
  expect(brief.stale).toContain('git')
  expect(brief.asOf.sha).toBe(undefined)
})

test('attention rules are pure and ordered', () => {
  const base: BriefSnapshot = { now: NOW, name: 'X', branch: 'main', dirtyCount: 0, pendingApprovals: [], failedTasks: [], blockedAgents: [], liveAgents: 0, readyTasks: 0, taskCounts: {} }
  expect(evaluateAttention(base).length).toBe(0)
  const all = evaluateAttention({ ...base, dirtyCount: 2, pendingApprovals: [{ id: 'a1', kind: 'k' }], failedTasks: [{ id: 't1', status: 'failed' }], blockedAgents: [{ id: 'g1', waitedMs: 11 * 60_000 }], readyTasks: 1 })
  expect(all.map((a) => a.rule).join(',')).toBe('approval_pending,task_failed,agent_blocked,dirty_no_agent,task_ready')
  expect(all[2]?.evidence).toContain('11 min')
  expect(evaluateAttention({ ...base, dirtyCount: 2, liveAgents: 1 }).length).toBe(0) // dirty but an agent is running
})

test('tasks ready on the board suggest task.assign, and plan items no longer count', () => {
  const base: BriefSnapshot = { now: NOW, name: 'X', branch: 'main', dirtyCount: 0, pendingApprovals: [], failedTasks: [], blockedAgents: [], liveAgents: 0, readyTasks: 2, taskCounts: {} }
  expect(evaluateAttention(base)).toEqual([{ rule: 'task_ready', evidence: '2 board tasks ready to assign', suggestedTool: 'task.assign' }])
})

test('brief from a real ledger: rules fire, stale parts named, within 800 tokens', async () => {
  const root = makeRepo()
  const kb = openKnowledgeDb(':memory:')
  const ledger = makeLedger(root)
  const long = 'k'.repeat(190)
  for (let i = 0; i < 8; i++) ledger.query("INSERT INTO approval (id, project_id, kind, status, created_at, updated_at) VALUES (?,?,?,'pending',?,?)").run(`ap-${i}-${'x'.repeat(150)}`, 'p1', long, NOW + i, NOW + i)
  ledger.query("INSERT INTO task (id, project_id, spec, status, created_at, updated_at) VALUES ('t-fail','p1','s','failed',?,?)").run(NOW, NOW)
  ledger.query("INSERT INTO central_agents (id, project_id, kind, runner, state, owner, started_at, last_event_at) VALUES ('ag1','p1','opencode','exec','waiting_input','human',?,?)").run(NOW - 3_600_000, NOW - 3_600_000)
  put(root, { 'src/dirty.ts': 'export const x = 1\n' })
  const brief = await buildBrief(ledger, kb, 'p1', root, NOW)
  const rules = brief.attention.map((a) => a.rule)
  expect(rules.includes('approval_pending')).toBe(true)
  expect(rules.includes('task_failed')).toBe(true)
  expect(rules.includes('agent_blocked')).toBe(true)
  expect(rules.includes('dirty_no_agent')).toBe(false) // one live (waiting) agent exists
  expect(brief.stale).toContain('index') // never indexed
  expect(brief.stale).toContain('tests') // no verified task
  expect(brief.status).toContain('1 failed')
  expect(brief.asOf.sha?.length).toBe(40)
  expect(estimateTokens(JSON.stringify(brief)) <= BRIEF_MAX_TOKENS).toBe(true)
  // deterministic: same inputs, same output
  expect(JSON.stringify(await buildBrief(ledger, kb, 'p1', root, NOW))).toBe(JSON.stringify(brief))
  // port: search labels freshness and indexes on demand
  const port = createKnowledgePort({ ledger, kb, now: () => NOW })
  const hit = await port.search('p1', 'zebraquokka', 3)
  expect(hit.stale).toBe(false)
  expect(hit.data[0]?.path).toBe('README.md')
  rmSync(root, { recursive: true, force: true })
})

test('fitBrief trims an oversized brief to the token cap', () => {
  const big: ProjectBrief = {
    projectId: 'p1', asOf: { at: NOW }, status: 's'.repeat(2000), next: ['a', 'b', 'c', 'd', 'e'], stale: [],
    attention: Array.from({ length: 40 }, (_, i) => ({ rule: `r${i}`, evidence: 'e'.repeat(500), suggestedTool: 'task.status' })),
  }
  const fit = fitBrief(big)
  expect(estimateTokens(JSON.stringify(fit)) <= BRIEF_MAX_TOKENS).toBe(true)
  expect(fit.attention[0]?.rule).toBe('r0') // highest priority survives
  expect(fit.next.length <= 3).toBe(true)
})
