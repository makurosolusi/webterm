import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskView, WorkStatus } from '../../../shared/centralWork'
import { GIT_SLOW_TEST_TIMEOUT_MS, put, sh } from '../../knowledge/knowledgeFixture.testutil'
import { migrate } from '../../ledger/migration'
import type { WorkMove } from '../work/workModel'
import { createHealthReview, parseDiff } from './healthReview'
import { createHealthStore } from './healthStore'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** A temp git repo: `base` committed, then `change` committed on top (the task's work). */
function repo(base: Record<string, string>, change: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'health-review-'))
  dirs.push(dir)
  sh(dir, 'init', '-q')
  put(dir, base)
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-qm', 'base')
  put(dir, change)
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-q', '--allow-empty', '-m', 'task')
  return dir
}

function setup(cwd: string | null) {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'p', '/tmp/p', 0, 0)`)
  db.exec(`INSERT INTO central_task (id, project_id, title, objective, created_by, created_at, updated_at, status) VALUES ('t1', 'p', 't', 'o', 'central', 0, 0, 'needs_review')`)
  let t = 1_800_000_000_000 // test-only fixed clock
  const now = () => t++
  const store = createHealthStore(db, now)
  const review = createHealthReview({ db, store, now, cwdOf: (id) => (id === 'p' ? cwd : null) })
  const move = (to: WorkStatus = 'needs_review'): WorkMove => ({
    task: { id: 't1', projectId: 'p', status: to } as TaskView, from: 'verifying', to, rule: null, reason: null, channel: null, seq: 1,
  })
  const scans = () => db.query(`SELECT status, origin FROM central_health_scan`).all() as { status: string; origin: string }[]
  const findings = () => store.list({ projectId: 'p', taskId: 't1', statuses: ['open'], limit: 200 })
  return { db, store, review, move, scans, findings }
}

describe('parseDiff', () => {
  test('collects added lines per file, marks new files, drops deleted ones', () => {
    const out = [
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -2,0 +3,2 @@', '+x', '+y', '@@ -9 +11 @@', '+z',
      'diff --git a/src/n.ts b/src/n.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/n.ts', '@@ -0,0 +1 @@', '+n',
      'diff --git a/src/gone.ts b/src/gone.ts', 'deleted file mode 100644', '--- a/src/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-g',
      'diff --git a/src/r.ts b/src/r.ts', '--- a/src/r.ts', '+++ b/src/r.ts', '@@ -4 +3,0 @@', '-removed only',
    ].join('\n')
    const files = parseDiff(out)
    expect([...files.keys()].sort()).toEqual(['src/a.ts', 'src/n.ts', 'src/r.ts'])
    expect(files.get('src/a.ts')).toEqual({ added: false, lines: new Set([3, 4, 11]) })
    expect(files.get('src/n.ts')).toEqual({ added: true, lines: 'all' })
    expect(files.get('src/r.ts')?.lines).toEqual(new Set())
  })
})

describe('createHealthReview', () => {
  test('a move into needs_review reports only what the task added, as review findings of that task', async () => {
    const dir = repo(
      {
        'src/old.ts': 'export const a = 1\n// TODO old debt\ntry { a } catch (e) {}\n',
        'src/kept.ts': 'export const k = 1\n',
        'src/kept.test.ts': "import './kept'\n",
      },
      {
        'src/old.ts': 'export const a = 1\n// TODO old debt\ntry { a } catch (e) {}\n// FIXME new debt\ntry { a } catch {}\n',
        'src/feature.ts': 'export const f = 1\n',
        'src/tested.ts': 'export const t = 1\n',
        'src/tested.bun.test.ts': "import './tested'\n",
        'src/TaskBoard.tsx': 'export const B = 1\n',
        'src/taskBoard.test.tsx': "import './TaskBoard'\n",
        'src/app.types.ts': 'export type A = 1\n',
        'src/index.ts': "export * from './feature'\n",
        'vite.config.ts': 'export default {}\n',
        'src/big.ts': 'x\n'.repeat(600),
        'src/big.test.ts': "import './big'\n",
      },
    )
    put(dir, { 'src/loose.ts': 'export const l = 1\n' }) // untracked: added by the task too
    const { review, move, scans, findings } = setup(dir)
    review.onMove(move())
    await review.idle()
    expect(scans()).toEqual([{ status: 'done', origin: 'review' }])
    const got = findings().map((f) => `${f.rule}:${f.file}:${f.line ?? '-'}`).sort()
    expect(got).toEqual([
      'empty_catch:src/old.ts:5',
      'file_size:src/big.ts:-',
      'new_file_no_test:src/feature.ts:-',
      'new_file_no_test:src/loose.ts:-',
      'todo_no_context:src/old.ts:4',
    ])
    const noTest = findings().find((f) => f.rule === 'new_file_no_test')!
    expect(noTest).toMatchObject({ origin: 'review', taskId: 't1', severity: 'medium', confidence: 'medium', source: 'Rule 3 (global CLAUDE.md)' })
  }, GIT_SLOW_TEST_TIMEOUT_MS)

  test('a later review of the same task fixes what the task no longer has', async () => {
    const dir = repo({ 'src/a.ts': 'export const a = 1\n', 'src/a.test.ts': "import './a'\n" }, { 'src/a.ts': 'export const a = 1\n// TODO later\n' })
    const { review, move, findings } = setup(dir)
    review.onMove(move())
    await review.idle()
    expect(findings().map((f) => f.rule)).toEqual(['todo_no_context'])
    put(dir, { 'src/a.ts': 'export const a = 1\n// TODO(a): later — issue #1\n' })
    review.onMove(move())
    await review.idle()
    expect(findings()).toEqual([])
  }, GIT_SLOW_TEST_TIMEOUT_MS)

  test('other moves, no checkout and no changed files record nothing', async () => {
    const dir = repo({ 'src/a.ts': 'export const a = 1\n', 'src/b.ts': 'export const b = 1\n' }, {})
    unlinkSync(join(dir, 'src/b.ts'))
    sh(dir, 'commit', '-qam', 'only a deletion')
    const clean = setup(dir)
    clean.review.onMove(clean.move('running'))
    clean.review.onMove(clean.move())
    await clean.review.idle()
    expect(clean.scans()).toEqual([])
    const none = setup(null)
    none.review.onMove(none.move())
    await none.review.idle()
    expect(none.scans()).toEqual([])
  }, GIT_SLOW_TEST_TIMEOUT_MS)

  test('git failure is logged, never thrown into the move, and leaves no scan', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'health-review-norepo-'))
    dirs.push(notRepo)
    const { review, move, scans } = setup(notRepo)
    review.onMove(move()) // a throw here fails the test: onMove must never throw into the move
    await review.idle()
    expect(scans()).toEqual([])
  }, GIT_SLOW_TEST_TIMEOUT_MS)

  test('single-flight per task: moves during a running review coalesce into one rerun', async () => {
    const dir = repo({ 'src/a.ts': 'export const a = 1\n' }, { 'src/a.ts': 'export const a = 2\n// TODO x\n' })
    const { review, move, scans } = setup(dir)
    review.onMove(move())
    review.onMove(move())
    review.onMove(move())
    await review.idle()
    expect(scans().length).toBe(2)
  }, GIT_SLOW_TEST_TIMEOUT_MS)
})
