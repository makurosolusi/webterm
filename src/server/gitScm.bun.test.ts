// Source Control (gitScm*.ts) against REAL git repos and a REAL bare remote, all under $TMPDIR and
// removed afterwards. Never touches a user repo, never pushes anywhere but the temp bare remote.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { promisify } from 'node:util'
import { capabilityProblems } from './capability/capability.define'
import { execute } from './cli/cli.exec'
import { cleanCommitMessage, suggestMessage } from './gitScm'
import { SCM_CAPABILITIES } from './gitScm.capabilities'
import { forgetReportsForTest, makeReport, scanPatch } from './gitScm.report'
import { gitScmRoute } from './gitScm.route'
import { commitMessageProblem, SCM_COMMIT_PATH, SCM_HUNKS_PATH, SCM_PUSH_PATH, SCM_REPORT_PATH, SCM_STAGE_PATH, SCM_STATUS_PATH, SCM_UNSTAGE_PATH, type ScmHunk, type ScmReport, type ScmStatus } from './gitScm.types'
import { forgetNodeToken, isValidNodeToken, nodeToken } from './hooksTokens'

const sh = promisify(execFile)
const T = 60_000
const HOST = '127.0.0.1:8700'
const BROWSER = { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' } // test-only: the webterm page
const NODE_ID = 'node-scm-test'
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.test' }
const saved: Record<string, string | undefined> = {}

let base = ''
let root = ''
let remote = ''
const at = (p: string) => npath.join(root, p)
const write = (p: string, s: string) => fs.mkdir(npath.dirname(at(p)), { recursive: true }).then(() => fs.writeFile(at(p), s))
const g = (...args: string[]) => sh('git', args, { cwd: root, env: { ...process.env, ...GIT_ENV } })

type Res = { status: number; body: Record<string, unknown> }
async function call(method: string, path: string, params: Record<string, unknown>, headers: Record<string, string> = BROWSER): Promise<Res> {
  const url = new URL(path, 'http://x')
  if (method === 'GET') for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const req = { method, headers } as unknown as IncomingMessage
  return (await gitScmRoute(req, url, () => Promise.resolve(JSON.stringify(params)), { isNodeToken: isValidNodeToken })) as Res
}
const status = async () => (await call('GET', SCM_STATUS_PATH, { root })).body as unknown as ScmStatus
const paths = (s: ScmStatus, area: 'staged' | 'unstaged' | 'untracked') => s[area].entries.map((e) => e.path)

const LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
const PKG_GREEN = JSON.stringify({ name: 'tmp', private: true, scripts: { test: 'echo tests-ok', typecheck: 'echo types-ok', lint: 'echo lint-ok' } })

beforeEach(async () => {
  // The server's own git calls read process.env: pin identity and ignore the user's global config (signing, hooks path).
  for (const [k, v] of Object.entries(GIT_ENV)) { saved[k] = process.env[k]; process.env[k] = v }
  base = await fs.realpath(await fs.mkdtemp(npath.join(tmpdir(), 'webterm-scm-')))
  root = npath.join(base, 'repo')
  remote = npath.join(base, 'remote.git')
  await fs.mkdir(root)
  await sh('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: { ...process.env, ...GIT_ENV } })
  await g('init', '-q', '-b', 'main')
  await write('mod.txt', LINES.join('\n') + '\n')
  await write('package.json', PKG_GREEN)
  await g('add', '-A')
  await g('commit', '-q', '-m', 'init')
  forgetReportsForTest()
})
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  forgetNodeToken(NODE_ID)
  await fs.rm(base, { recursive: true, force: true })
})

test('status groups staged, unstaged and untracked, and flags secret names', async () => {
  await write('mod.txt', ['CHANGED', ...LINES.slice(1)].join('\n') + '\n')
  await write('staged.txt', 's\n')
  await g('add', 'staged.txt')
  await write('both.txt', 'one\n')
  await g('add', 'both.txt')
  await write('both.txt', 'two\n')
  await write('new/untracked.txt', 'u\n')
  await write('.env', 'X=1\n')
  const s = await status()
  expect(s.branch).toBe('main')
  expect(paths(s, 'staged')).toEqual(['both.txt', 'staged.txt'])
  expect(paths(s, 'unstaged').sort()).toEqual(['both.txt', 'mod.txt'])
  expect(paths(s, 'untracked').sort()).toEqual(['.env', 'new/untracked.txt'])
  expect(s.untracked.entries.find((e) => e.path === '.env')).toMatchObject({ sensitive: true, sensitivePattern: '.env' })
  expect(s.staged.total).toBe(2)
}, T)

test('stage and unstage one hunk leaves the other hunk where it was', async () => {
  const next = [...LINES]
  next[1] = 'TOP'
  next[37] = 'BOTTOM'
  await write('mod.txt', next.join('\n') + '\n')
  const h = await call('GET', SCM_HUNKS_PATH, { root, path: 'mod.txt', area: 'unstaged' })
  const hunks = h.body.hunks as ScmHunk[]
  expect(hunks).toHaveLength(2)
  expect((await call('POST', SCM_STAGE_PATH, { root, path: 'mod.txt', hunkId: hunks[1].id })).status).toBe(200)
  const cached = (await g('diff', '--cached')).stdout
  expect(cached).toContain('+BOTTOM')
  expect(cached).not.toContain('+TOP')
  expect((await g('diff')).stdout).toContain('+TOP')

  const staged = (await call('GET', SCM_HUNKS_PATH, { root, path: 'mod.txt', area: 'staged' })).body.hunks as ScmHunk[]
  expect(staged).toHaveLength(1)
  expect((await call('POST', SCM_UNSTAGE_PATH, { root, path: 'mod.txt', hunkId: staged[0].id })).status).toBe(200)
  expect((await g('diff', '--cached')).stdout).toBe('')
  // A stale id (file changed since) is refused, not applied blindly.
  expect((await call('POST', SCM_STAGE_PATH, { root, path: 'mod.txt', hunkId: staged[0].id })).status).toBe(409)
}, T)

test('stage and unstage a whole file, including a new file', async () => {
  await write('a.txt', 'a\n')
  expect((await call('POST', SCM_STAGE_PATH, { root, path: 'a.txt' })).status).toBe(200)
  expect(paths(await status(), 'staged')).toEqual(['a.txt'])
  expect((await call('POST', SCM_UNSTAGE_PATH, { root, path: 'a.txt' })).status).toBe(200)
  expect(paths(await status(), 'untracked')).toContain('a.txt')
  // A directory is not an entry: staging it wholesale is refused.
  await write('dir/x.txt', 'x\n')
  expect((await call('POST', SCM_STAGE_PATH, { root, path: 'dir' })).status).toBe(404)
}, T)

test('a secret-named file is refused with the reason and never staged', async () => {
  await write('config/.env.local', 'API_KEY=abc\n')
  await write('id_rsa', 'k\n')
  const r = await call('POST', SCM_STAGE_PATH, { root, path: 'config/.env.local' })
  expect(r.status).toBe(403)
  expect(r.body.error).toBe('sensitive')
  expect(String(r.body.message)).toContain('secret pattern')
  expect((await call('POST', SCM_STAGE_PATH, { root, path: 'id_rsa' })).status).toBe(403)
  expect((await g('diff', '--cached', '--name-only')).stdout).toBe('')
  // Staged behind the panel's back (CLI): the commit is refused too.
  await g('add', '-f', 'id_rsa')
  const c = await call('POST', SCM_COMMIT_PATH, { root, message: 'feat(keys): add deploy key' })
  expect(c.status).toBe(403)
}, T)

test('commit message must follow Rule 9', () => {
  expect(commitMessageProblem('feat(auth): add refresh token rotation')).toBeNull()
  expect(commitMessageProblem('fix(scm): refuse staging of secret files\n\nBody line.')).toBeNull()
  expect(commitMessageProblem('fix bug')).not.toBeNull()
  expect(commitMessageProblem('feat: add thing')).not.toBeNull() // no scope
  expect(commitMessageProblem('feature(x): add thing')).not.toBeNull() // unknown type
  expect(commitMessageProblem('fix(core): update')).not.toBeNull() // generic
  expect(commitMessageProblem('fix(core): wip')).not.toBeNull()
  expect(commitMessageProblem('fix(core): add guard.')).not.toBeNull()
  expect(commitMessageProblem('')).not.toBeNull()
  expect(cleanCommitMessage('```\nfeat(scm): add panel\n```')).toBe('feat(scm): add panel')
})

test('commit refuses a bad message and commits a good one', async () => {
  await write('a.txt', 'a\n')
  await call('POST', SCM_STAGE_PATH, { root, path: 'a.txt' })
  const badMsg = await call('POST', SCM_COMMIT_PATH, { root, message: 'update' })
  expect(badMsg.status).toBe(400)
  expect(badMsg.body.error).toBe('bad_message')
  const ok = await call('POST', SCM_COMMIT_PATH, { root, message: 'feat(scm): add a file' })
  expect(ok.status).toBe(200)
  expect((await g('log', '-1', '--format=%s')).stdout.trim()).toBe('feat(scm): add a file')
}, T)

test('a failing pre-commit hook comes back with its output and a repair prompt', async () => {
  await fs.writeFile(at('.git/hooks/pre-commit'), '#!/bin/sh\necho "lint: 3 problems in a.txt" >&2\nexit 1\n', { mode: 0o755 })
  await write('a.txt', 'a\n')
  await call('POST', SCM_STAGE_PATH, { root, path: 'a.txt' })
  const r = await call('POST', SCM_COMMIT_PATH, { root, message: 'feat(scm): add a file' })
  expect(r.status).toBe(409)
  expect(r.body.error).toBe('commit_failed')
  expect(String(r.body.output)).toContain('lint: 3 problems')
  expect(String(r.body.fixPrompt)).toContain('Do not bypass hooks with --no-verify')
  expect(String(r.body.fixPrompt)).toContain('a.txt')
}, T)

test('AI message: staged patch reaches the model, secret contents do not', async () => {
  await write('a.txt', 'hello\n')
  await g('add', 'a.txt')
  await write('.env', 'SECRETVALUE=zzz\n')
  await g('add', '-f', '.env')
  let prompt = ''
  const s = await suggestMessage(root, async (p) => { prompt = p; return '"feat(scm): add greeting file"' })
  expect(s).toEqual({ message: 'feat(scm): add greeting file', problem: null })
  expect(prompt).toContain('+hello')
  expect(prompt).toContain('.env') // named in the file list
  expect(prompt).not.toContain('zzz') // contents withheld
  const bad = await suggestMessage(root, async () => 'Added a greeting')
  expect(bad.problem).not.toBeNull()
}, T)

test('report runs the project scripts and captures a failure', async () => {
  await write('package.json', JSON.stringify({ scripts: { test: 'echo boom-from-test >&2; exit 3', lint: 'echo lint-ok' } }))
  await g('commit', '-qam', 'chore(tmp): red scripts')
  const r = await makeReport(root)
  expect(r.checks.map((c) => [c.name, c.status])).toEqual([['test', 'fail'], ['typecheck', 'skipped'], ['lint', 'pass']])
  expect(r.checks[0].output).toContain('boom-from-test')
  expect(r.checks[0].detail).toBe('npm run test')
  expect(r.checks[1].detail).toContain('no typecheck')
  expect(r.green).toBe(false)
}, T)

test('report kills a script that runs past its timeout', async () => {
  await write('package.json', JSON.stringify({ scripts: { test: 'sleep 30' } }))
  const t0 = Date.now()
  const r = await makeReport(root, { timeoutMs: 1500 })
  expect(r.checks[0].status).toBe('timeout')
  expect(Date.now() - t0 < 15_000).toBe(true)
}, T)

test('credential scan catches a fake key and lists TODOs, never echoing the value', async () => {
  const fake = 'AKIA' + 'ABCDEFGHIJKLMNOP' // test-only fixture, not a real key
  await write('src/conf.ts', `export const region = 'x'\nconst k = '${fake}'\n// TODO: tidy\n`)
  await g('add', 'src/conf.ts')
  const r = await makeReport(root)
  expect(r.credentials).toEqual([{ path: 'src/conf.ts', line: 2, text: 'credential-shaped value' }])
  expect(r.debt).toEqual([{ path: 'src/conf.ts', line: 3, text: '// TODO: tidy' }])
  expect(JSON.stringify(r)).not.toContain(fake)
  expect(r.green).toBe(false)
  expect(scanPatch('+++ b/.env\n@@ -0,0 +1 @@\n+X=1\n').credentials[0]).toMatchObject({ path: '.env', text: 'secret-named file in the diff' })
}, T)

test('push: denied for agent credentials, refused without a green report, allowed for the UI after one', async () => {
  await g('remote', 'add', 'origin', remote)
  await write('a.txt', 'a\n')
  await g('add', 'a.txt')
  await g('commit', '-qm', 'feat(scm): add a file')

  // Node agent (its own token), Central / CLI (capability token), plain curl: all 403.
  const agent = await call('POST', SCM_PUSH_PATH, { root }, { ...BROWSER, 'x-webterm-token': nodeToken(NODE_ID) })
  expect(agent).toMatchObject({ status: 403, body: { error: 'agent_cannot_use_scm' } })
  expect((await call('POST', SCM_PUSH_PATH, { root }, { ...BROWSER, 'x-webterm-capability': 'wcap_central' })).status).toBe(403)
  expect((await call('POST', SCM_PUSH_PATH, { root }, { host: HOST })).status).toBe(403)
  expect((await call('POST', SCM_REPORT_PATH, { root }, { ...BROWSER, 'x-webterm-token': nodeToken(NODE_ID) })).status).toBe(403)

  // Human UI without a report: refused.
  expect((await call('POST', SCM_PUSH_PATH, { root })).body.error).toBe('no_report')
  const rep = (await call('POST', SCM_REPORT_PATH, { root })).body.report as ScmReport
  expect(rep.green).toBe(true)
  expect(rep.checks.every((c) => c.status === 'pass')).toBe(true)
  const ok = await call('POST', SCM_PUSH_PATH, { root })
  expect(ok.status).toBe(200)
  const remoteHead = (await sh('git', ['--git-dir', remote, 'rev-parse', 'main'])).stdout.trim()
  expect(remoteHead).toBe((await g('rev-parse', 'HEAD')).stdout.trim())
  expect((await status()).upstream).toBe('origin/main')

  // A new commit makes the report stale.
  await write('b.txt', 'b\n')
  await g('add', 'b.txt')
  await g('commit', '-qm', 'feat(scm): add b')
  expect((await call('POST', SCM_PUSH_PATH, { root })).body.error).toBe('report_stale')
}, T)

test('push: a red report needs explicit acknowledgement; a credential finding cannot be acknowledged', async () => {
  await g('remote', 'add', 'origin', remote)
  await write('package.json', JSON.stringify({ scripts: { test: 'exit 1' } }))
  await g('commit', '-qam', 'chore(tmp): red test')
  await call('POST', SCM_REPORT_PATH, { root })
  expect((await call('POST', SCM_PUSH_PATH, { root })).body.error).toBe('report_red')
  expect((await call('POST', SCM_PUSH_PATH, { root, acknowledge: true })).status).toBe(200)

  await write('k.ts', `const t = '${'ghp_' + 'a'.repeat(36)}'\n`) // test-only fake token
  await g('add', 'k.ts')
  await g('commit', '-qm', 'feat(k): add k')
  await call('POST', SCM_REPORT_PATH, { root })
  const r = await call('POST', SCM_PUSH_PATH, { root, acknowledge: true })
  expect(r.body.error).toBe('credentials_found')
  const remoteHead = (await sh('git', ['--git-dir', remote, 'rev-parse', 'main'])).stdout.trim()
  expect(remoteHead).not.toBe((await g('rev-parse', 'HEAD')).stdout.trim())
}, T)

test('SCM capabilities are well formed; push/pr are R3 destructive; a policy allow still meets the route 403', async () => {
  for (const cap of SCM_CAPABILITIES) expect(capabilityProblems(cap)).toEqual([])
  const pushCap = SCM_CAPABILITIES.find((c) => c.name === 'git.scm.push')!
  expect(pushCap).toMatchObject({ tier: 'R3', destructive: true })
  expect(SCM_CAPABILITIES.find((c) => c.name === 'git.scm.pr')).toMatchObject({ tier: 'R3', destructive: true })

  await g('remote', 'add', 'origin', remote)
  await call('POST', SCM_REPORT_PATH, { root })
  // `webterm` CLI path for a node, with a policy that allows everything: the in-process dispatch
  // carries no browser fetch metadata, so the route itself refuses.
  const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const c of req as unknown as AsyncIterable<Buffer>) chunks.push(c)
    const out = await gitScmRoute(req, new URL(req.url!, 'http://x'), async () => Buffer.concat(chunks).toString())
    res.statusCode = out?.status ?? 404
    res.end(JSON.stringify(out?.body ?? {}))
  }
  const allowAll = { decide: () => ({ effect: 'allow' as const, reason: 'test' }), evaluate: () => ({ effect: 'allow' as const, reason: 'test' }) }
  const { receipt } = await execute({ dispatch, policy: () => allowAll, workspaces: () => [] }, pushCap, { root }, `node:${NODE_ID}`, {})
  expect(receipt.outcome).toBe('denied')
  expect(receipt.evidence.status).toBe(403)
  expect((await sh('git', ['--git-dir', remote, 'branch', '--list'])).stdout.trim()).toBe('')
}, T)
