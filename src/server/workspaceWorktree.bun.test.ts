// Real git on throwaway repos under a temp dir: never touches the user's repos or data dir.
import { TEST_UI_COOKIE } from './uiSession.testutil'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { Db, openDb } from './db'
import { workspacesRoute } from './workspacesApi'
import { branchSlug, createWorkspaceWorktree, removeWorkspaceWorktree, worktreeStatus } from './workspaceWorktree'
import { parseWorktreeInclude } from './workspaceWorktree.setup'
import { workspaceWorktreeRoute } from './workspaceWorktree.route'

// Real git spawns; under a full parallel gate one test exceeded bun's 5 s default.
const GIT_TEST_TIMEOUT_MS = 30_000
let tmp: string
let repo: string
let root: string
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
/** Error code of a rejected call (`rejects` is not in the local bun:test typings). */
const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: string }) => e.code)

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wsw-')))
  repo = join(tmp, 'proj')
  root = join(tmp, 'worktrees')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, '.gitignore'), '.env\n.vscode/\nsecret.txt\n')
  writeFileSync(join(repo, 'README.md'), 'hi\n')
  writeFileSync(join(repo, '.worktreeinclude'), '# local files\n.env\n.vscode/\nREADME.md\nmissing.env\n*.local\n../escape\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  writeFileSync(join(repo, '.env'), 'TOKEN=local\n')
  execFileSync('mkdir', ['-p', join(repo, '.vscode')])
  writeFileSync(join(repo, '.vscode', 'settings.json'), '{}')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

test('branchSlug derives a git-safe name from a task title', () => {
  expect(branchSlug('Fix: Login bug (#42)!')).toBe('fix-login-bug-42')
  expect(branchSlug('Café crème')).toBe('cafe-creme')
  expect(branchSlug('   ')).toBe('workspace')
})

test('parseWorktreeInclude keeps literal relative paths and skips globs, negation and traversal', () => {
  const r = parseWorktreeInclude('# c\n\n./.env\n.vscode/\n*.local\n!x\n../up\n/abs\n.git/config\n.env\n')
  expect(r.paths).toEqual(['.env', '.vscode'])
  expect(r.skipped).toHaveLength(5)
})

test('create: unique branch under <root>/<repo>/, .worktreeinclude copies only gitignored files, setup runs', async () => {
  writeFileSync(join(repo, 'orca.yaml'), 'scripts:\n  setup: |\n    echo "setup in $ORCA_WORKTREE_PATH"\n    echo ok > .setup-done\n')
  git(repo, 'add', 'orca.yaml')
  git(repo, 'commit', '-qm', 'orca')
  git(repo, 'branch', 'add-login') // branch name taken → suffix
  const created = await createWorkspaceWorktree({ repo, title: 'Add login' }, { root })
  expect(created.branch).toBe('add-login-2')
  expect(created.base).toBe('main')
  expect(created.path).toBe(join(root, 'proj', 'add-login-2'))
  expect(git(created.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('add-login-2')
  expect(readFileSync(join(created.path, '.env'), 'utf8')).toBe('TOKEN=local\n')
  expect(existsSync(join(created.path, '.vscode', 'settings.json'))).toBe(true)
  expect(created.includes.copied.sort()).toEqual(['.env', '.vscode'])
  expect(created.includes.skipped.join('\n')).toContain('README.md: not gitignored')
  expect(created.includes.skipped.join('\n')).toContain('missing.env: missing')
  // copied files never become stageable
  expect(git(created.path, 'status', '--porcelain')).toBe('?? .setup-done') // .env/.vscode stay ignored
  expect(created.setup).toMatchObject({ source: 'orca.yaml', ran: true, ok: true, timedOut: false })
  expect(created.setup.output).toContain(`setup in ${created.path}`)
  expect(existsSync(join(created.path, '.setup-done'))).toBe(true)

  const second = await createWorkspaceWorktree({ repo, title: 'Add login' }, { root })
  expect(second.branch).toBe('add-login-3')
}, GIT_TEST_TIMEOUT_MS)

test('create: webterm.yaml wins, and a slow setup script is killed at the timeout', async () => {
  writeFileSync(join(repo, 'webterm.yaml'), 'scripts:\n  setup: |\n    echo started\n    sleep 30\n')
  git(repo, 'add', 'webterm.yaml')
  git(repo, 'commit', '-qm', 'wt')
  const t0 = Date.now()
  const created = await createWorkspaceWorktree({ repo, title: 'slow' }, { root, setupTimeoutMs: 500 })
  expect(10_000).toBeGreaterThan(Date.now() - t0)
  expect(created.setup).toMatchObject({ source: 'webterm.yaml', ran: true, ok: false, timedOut: true })
  expect(created.setup.output).toContain('started')
  expect(created.setup.output).toContain('timed out')
}, GIT_TEST_TIMEOUT_MS)

test('create: refuses to copy an include the new branch does not gitignore', async () => {
  git(repo, 'checkout', '-qb', 'no-ignore')
  writeFileSync(join(repo, '.gitignore'), '.vscode/\n') // .env no longer ignored on this base
  git(repo, 'commit', '-qam', 'drop env ignore')
  git(repo, 'checkout', '-q', 'main')
  const created = await createWorkspaceWorktree({ repo, title: 'x', base: 'no-ignore' }, { root })
  expect(existsSync(join(created.path, '.env'))).toBe(false)
  expect(created.includes.skipped.join('\n')).toContain('.env: not gitignored on the new branch')
}, GIT_TEST_TIMEOUT_MS)

test('create: explicit branch that exists is refused, bad base is refused', async () => {
  git(repo, 'branch', 'taken')
  expect(await codeOf(createWorkspaceWorktree({ repo, title: 'x', branch: 'taken' }, { root }))).toBe('branch_in_use')
  expect(await codeOf(createWorkspaceWorktree({ repo, title: 'x', base: 'nope' }, { root }))).toBe('invalid_base')
  expect(await codeOf(createWorkspaceWorktree({ repo: tmp, title: 'x' }, { root }))).toBe('invalid_repo')
}, GIT_TEST_TIMEOUT_MS)

test('workspace created with the worktree as cwd opens agents there', async () => {
  const created = await createWorkspaceWorktree({ repo, title: 'Agent task' }, { root })
  const store = new Db(openDb(':memory:'))
  const res = await workspacesRoute(store, '/api/workspaces', 'POST', async () => JSON.stringify({ name: 'Agent task', cwd: created.path }))
  expect(res?.status).toBe(201)
  expect((res?.body as { cwd: string }).cwd).toBe(created.path)
  expect(store.list()[0].cwd).toBe(created.path)
}, GIT_TEST_TIMEOUT_MS)

test('status reports branch, dirty and unpushed; primary checkout is not managed', async () => {
  const { path } = await createWorkspaceWorktree({ repo, title: 'st' }, { root })
  expect(await worktreeStatus(path, { root })).toMatchObject({ managed: true, branch: 'st', dirtyCount: 0, unpushed: 0 })
  writeFileSync(join(path, 'new.txt'), 'x')
  expect(await worktreeStatus(path, { root })).toMatchObject({ dirtyCount: 1, dirty: ['?? new.txt'] })
  git(path, 'add', 'new.txt')
  git(path, 'commit', '-qm', 'work')
  expect(await worktreeStatus(path, { root })).toMatchObject({ dirtyCount: 0, unpushed: 1 })
  expect((await worktreeStatus(repo, { root })).managed).toBe(false)
}, GIT_TEST_TIMEOUT_MS)

test('remove refuses dirty work without confirm, removes after confirm, keeps the branch', async () => {
  const { path } = await createWorkspaceWorktree({ repo, title: 'dirty' }, { root })
  writeFileSync(join(path, 'wip.txt'), 'unsaved')
  const refused = await removeWorkspaceWorktree({ path }, { root })
  expect(refused).toMatchObject({ removed: false, needsConfirm: true })
  expect(existsSync(join(path, 'wip.txt'))).toBe(true)
  const done = await removeWorkspaceWorktree({ path, confirm: true }, { root })
  expect(done).toMatchObject({ removed: true, branch: 'dirty', branchDeleted: false })
  expect(existsSync(path)).toBe(false)
  expect(git(repo, 'branch', '--list', 'dirty')).toContain('dirty')
}, GIT_TEST_TIMEOUT_MS)

test('remove: unpushed commits need confirm; deleteBranch uses -d and keeps unmerged work', async () => {
  const { path } = await createWorkspaceWorktree({ repo, title: 'feat' }, { root })
  writeFileSync(join(path, 'f.txt'), 'x')
  git(path, 'add', 'f.txt')
  git(path, 'commit', '-qm', 'feat')
  expect(await removeWorkspaceWorktree({ path, deleteBranch: true }, { root })).toMatchObject({ removed: false })
  const r = await removeWorkspaceWorktree({ path, confirm: true, deleteBranch: true }, { root })
  expect(r).toMatchObject({ removed: true, branchDeleted: false })
  expect(git(repo, 'branch', '--list', 'feat')).toContain('feat') // unmerged: kept by `git branch -d`

  const clean = await createWorkspaceWorktree({ repo, title: 'clean' }, { root })
  expect(await removeWorkspaceWorktree({ path: clean.path, deleteBranch: true }, { root })).toMatchObject({ removed: true, branchDeleted: true })
  expect(git(repo, 'branch', '--list', 'clean')).toBe('')
}, GIT_TEST_TIMEOUT_MS)

test('remove refuses paths outside the webterm root', async () => {
  expect(await codeOf(removeWorkspaceWorktree({ path: repo, confirm: true }, { root }))).toBe('not_found')
  expect(existsSync(repo)).toBe(true)
}, GIT_TEST_TIMEOUT_MS)

test('route: agent credentials get 403 on POST, needs_confirm is a 409', async () => {
  const req = (headers: Record<string, string>) => ({ method: 'POST', headers }) as unknown as IncomingMessage
  const u = (p: string) => new URL(`http://127.0.0.1:8700${p}`)
  const agent = await workspaceWorktreeRoute(req({ 'x-webterm-token': 'node-tok' }), u('/api/workspace-worktree/create'), async () => '{}', { root, isNodeToken: () => true })
  expect(agent?.status).toBe(403)
  const ui = { 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE, origin: 'http://127.0.0.1:8700', host: '127.0.0.1:8700' }
  const created = await workspaceWorktreeRoute(req(ui), u('/api/workspace-worktree/create'), async () => JSON.stringify({ repo, title: 'Route' }), { root, isNodeToken: () => false })
  expect(created?.status).toBe(201)
  const path = (created?.body as { path: string }).path
  writeFileSync(join(path, 'wip'), 'x')
  const r = await workspaceWorktreeRoute(req(ui), u('/api/workspace-worktree/remove'), async () => JSON.stringify({ path }), { root, isNodeToken: () => false })
  expect(r?.status).toBe(409)
  expect(r?.body).toMatchObject({ error: 'needs_confirm' })
  expect(await workspaceWorktreeRoute(req(ui), u('/api/other'), async () => '{}', { root })).toBeNull()
}, GIT_TEST_TIMEOUT_MS)
