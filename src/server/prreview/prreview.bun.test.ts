// PR review bot end to end, no network: a local bare "origin" holding refs/pull/7/head (as GitHub
// does), a fake `gh` script first on PATH (auth status / pr view / pr list / pr diff / api), the real
// `agent.spawn` spawner and process runner with a fake agent in place of `claude`, real worktrees and
// a real in-memory ledger with the Inbox. Nothing may reach GitHub before the human approves.
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startExec, type ExecSpec } from '../central/agents/execRunner'
import { actOnItem, actOnItems } from '../inbox/inboxActions'
import { getInboxItem, listInboxItems } from '../inbox/inboxItemStore'
import { migrate } from '../ledger/migration'
import { createRoutineRunner } from '../routines/routineRunner'
import { createRoutineStore } from '../routines/routineStore'
import { createAgentSpawner } from '../spawn/agentSpawn'
import { handlePrReviewApi } from './prreview.api'
import { createGh } from './prreview.gh'
import { createPrReviewService, type PrReviewService } from './prreview.service'

const T = 60_000
const TEST_TOKEN = 'ghp_test_only_not_real' // test-only
let tmp: string, repo: string, fake: string, db: Database, head: string, argvSeen: string[][]
let env: NodeJS.ProcessEnv
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: string }) => e.code)
const ghLog = () => (existsSync(join(fake, 'log')) ? readFileSync(join(fake, 'log'), 'utf8').trim().split('\n') : [])
const posted = () => (existsSync(join(fake, 'posted.json')) ? JSON.parse(readFileSync(join(fake, 'posted.json'), 'utf8')) : null)

// Fake gh: logs argv (and whether a token rode the env, never its value), answers from files in $FAKE_GH.
const FAKE_GH = `#!/bin/sh
echo "$* token=$([ -n "$GH_TOKEN" ] && echo set || echo none)" >> "$FAKE_GH/log"
case "$1 $2" in
  "auth status") [ -n "$GH_TOKEN" ] && exit 0; exit "$(cat "$FAKE_GH/auth")" ;;
  "pr view") cat "$FAKE_GH/pr-$3.json" ;;
  "pr list") cat "$FAKE_GH/list.json" ;;
  "pr diff") cat "$FAKE_GH/diff-$3.patch" ;;
  "api --method") cat > "$FAKE_GH/posted.json"; echo '{"id":1,"html_url":"https://github.com/o/r/pull/7#pullrequestreview-1"}' ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
`

/** Claude Code's final result event whose text holds the findings block. */
function setAnswer(findings: unknown, summary = 'Adds a greeting; one bug.'): void {
  const text = findings === null ? 'I could not review this.' : `\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\n${summary}`
  writeFileSync(join(tmp, 'answer.jsonl'), `${JSON.stringify({ type: 'result', is_error: false, result: text, total_cost_usd: 0.05 })}\n`)
}

function service(readSecret: (n: string) => string | null = () => null): PrReviewService {
  const spawner = createAgentSpawner({
    record: () => {}, registerSpawn: () => {}, ancestors: () => [], onPtyExit: () => {},
    exec: (spec: ExecSpec) => {
      argvSeen.push([...spec.argv])
      return startExec({ ...spec, argv: ['sh', '-c', `git rev-parse HEAD > "${tmp}/seen-head"; cat "${tmp}/answer.jsonl"`] })
    },
  })
  return createPrReviewService({ ctx: { db, now: Date.now }, gh: createGh({ env, readSecret }), spawn: (r) => spawner.spawn(r), worktree: { root: join(tmp, 'worktrees') } })
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'prr-')))
  const origin = join(tmp, 'origin.git')
  repo = join(tmp, 'proj')
  fake = join(tmp, 'fakegh')
  mkdirSync(join(fake, 'bin'), { recursive: true })
  writeFileSync(join(fake, 'bin', 'gh'), FAKE_GH)
  chmodSync(join(fake, 'bin', 'gh'), 0o755)
  writeFileSync(join(fake, 'auth'), '0')
  env = { ...process.env, PATH: `${join(fake, 'bin')}:${process.env.PATH}`, FAKE_GH: fake }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN

  execFileSync('git', ['init', '-q', '--bare', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'user.email', 't@t')
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', 'origin', 'main')
  // The PR: a branch pushed only as GitHub's refs/pull/7/head; the local repo does not have it yet.
  git(repo, 'checkout', '-qb', 'feat')
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1\nexport const hello = (n: string) => `hi ${n}`\n')
  git(repo, 'commit', '-qam', 'feat: hello')
  head = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(fake, 'diff-7.patch'), `${git(repo, 'diff', 'main...feat')}\n`)
  git(repo, 'push', '-q', 'origin', `HEAD:refs/pull/7/head`)
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'branch', '-qD', 'feat')
  const pr = { number: 7, title: 'feat: hello', url: 'https://github.com/o/r/pull/7', headRefOid: head, baseRefName: 'main' }
  writeFileSync(join(fake, 'pr-7.json'), JSON.stringify(pr))
  writeFileSync(join(fake, 'list.json'), JSON.stringify([pr]))

  db = new Database(':memory:')
  migrate(db)
  argvSeen = []
  setAnswer([
    { file: 'a.ts', line: 2, severity: 'high', summary: 'hello ignores an empty name' },
    { file: 'a.ts', line: 40, severity: 'low', summary: 'consider a doc comment' },
    { file: 'b.ts', line: 'x', summary: 'malformed, dropped' },
  ])
})
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

async function drafted(svc: PrReviewService): Promise<string> {
  const job = svc.start({ repo, pr: 7, workspaceId: 'ws1' })
  await svc.settled(job.id)
  const done = svc.jobs(repo)[0]!
  expect(done).toMatchObject({ status: 'drafted', findings: 2, error: null })
  return done.itemId!
}

const req = (method: string, headers: Record<string, string> = {}) => ({ method, headers }) as unknown as IncomingMessage
const ui = { 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE, origin: 'http://127.0.0.1:8700', host: '127.0.0.1:8700' }
const u = (p: string) => new URL(`http://127.0.0.1:8700${p}`)
const body = (v: unknown) => async () => JSON.stringify(v)

test('reviews the PR head in a read-only worktree and drafts findings in the Inbox without posting', async () => {
  const svc = service()
  const itemId = await drafted(svc)
  // Headless Claude Code with read-only tools, run inside a checkout of the PR head.
  expect(argvSeen).toHaveLength(1)
  const argv = argvSeen[0]!
  expect(argv.slice(0, 2)).toEqual(['claude', '-p'])
  expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Glob,Grep')
  expect(argv[2]).toContain('REPO: o/r\nPR NUMBER: 7')
  expect(argv[2]).toContain('+export const hello')
  expect(readFileSync(join(tmp, 'seen-head'), 'utf8').trim()).toBe(head)
  // The review worktree and its branch are gone again.
  expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  expect(git(repo, 'branch', '--list', 'prreview-*')).toBe('')

  const item = getInboxItem(db, itemId)!
  expect(item).toMatchObject({ kind: 'gate', source: 'prreview', status: 'open', workspaceId: 'ws1' })
  expect(item.impact).toEqual({ what: 'Posts one review with 1 inline comment to o/r#7 on GitHub', tier: 'R3', rewindable: false })
  expect(item.actions).toContain('edit')
  expect((item.args as { findings: unknown[] }).findings).toEqual([
    { file: 'a.ts', line: 2, severity: 'high', summary: 'hello ignores an empty name', inline: true },
    { file: 'a.ts', line: 40, severity: 'low', summary: 'consider a doc comment', inline: false },
  ])
  expect(item.body).toContain('(outside diff) a.ts:40 [low]')
  expect(svc.drafts(repo)).toMatchObject([{ itemId, pr: 7, findings: 2, inline: 1 }])
  // Nothing went to GitHub: only reads.
  expect(posted()).toBeNull()
  expect(ghLog().map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual(['auth status', 'pr view', 'auth status', 'pr diff'])
}, T)

test('Post review posts exactly one review after the click; agents and repeats are refused', async () => {
  const svc = service()
  const itemId = await drafted(svc)
  expect(await codeOf(svc.post(itemId))).toBe('not_approved') // no approval yet
  await svc.reconcile()
  expect(posted()).toBeNull()

  const deps = { service: svc, ctx: { db, now: Date.now }, isNodeToken: () => true, record: () => {} }
  const agent = await handlePrReviewApi(deps, req('POST', { 'x-webterm-token': 'node-tok' }), u(`/api/prreview/${itemId}/post`), body({}))
  expect(agent?.status).toBe(403)
  expect(posted()).toBeNull()

  const human = { ...deps, isNodeToken: () => false }
  const res = await handlePrReviewApi(human, req('POST', ui), u(`/api/prreview/${itemId}/post`), body({}))
  expect(res).toEqual({ status: 200, body: { url: 'https://github.com/o/r/pull/7#pullrequestreview-1' } })
  const payload = posted()
  expect(payload).toMatchObject({ commit_id: head, event: 'COMMENT', comments: [{ path: 'a.ts', line: 2, side: 'RIGHT', body: '**high**: hello ignores an empty name' }] })
  expect(payload.comments).toHaveLength(1)
  expect(payload.body).toContain('Adds a greeting; one bug.')
  expect(payload.body).toContain('`a.ts:40` **low**: consider a doc comment')
  expect(ghLog().filter((l) => l.startsWith('api '))).toEqual(['api --method POST repos/o/r/pulls/7/reviews --input - token=none'])
  expect(getInboxItem(db, itemId)).toMatchObject({ status: 'done', resolution: 'posted: https://github.com/o/r/pull/7#pullrequestreview-1' })

  // Second click: the consent was single use.
  const again = await handlePrReviewApi(human, req('POST', ui), u(`/api/prreview/${itemId}/post`), body({}))
  expect(again?.status).toBe(409)
  expect(ghLog().filter((l) => l.startsWith('api '))).toHaveLength(1)
}, T)

test('approving an edited draft in the Inbox posts the edited findings; deny never posts', async () => {
  const svc = service()
  const itemId = await drafted(svc)
  const args = getInboxItem(db, itemId)!.args as { findings: Array<{ inline: boolean }> }
  const edited = { ...args, findings: args.findings.filter((f) => f.inline), summary: 'Edited by me.' }
  const inbox = { ctx: { db, now: Date.now }, actor: 'human:loopback', record: () => {}, outbox: () => Promise.reject(new Error('no mail')) }
  // An R3 draft is never batch-approved (approval-fatigue guard): it must be approved on its own.
  expect((await actOnItems(inbox, [itemId], { type: 'approve' }))[0]).toMatchObject({ status: 409, body: { error: 'needs_individual_review' } })
  await svc.reconcile()
  expect(posted()).toBeNull()
  expect((await actOnItem(inbox, itemId, { type: 'edit', args: edited })).status).toBe(200)
  await svc.reconcile() // what the inbox.decision subscriber (and a restart) does
  expect(posted()).toMatchObject({ comments: [{ path: 'a.ts', line: 2 }] })
  expect(posted().body).toContain('Edited by me.')
  expect(posted().body).not.toContain('a.ts:40')

  // A second PR head, denied: nothing is posted, not even by reconcile.
  rmSync(join(fake, 'posted.json'))
  const second = await drafted(svc)
  expect((await actOnItem(inbox, second, { type: 'deny' })).status).toBe(200)
  await svc.reconcile()
  expect(await codeOf(svc.post(second))).toBe('not_approved')
  expect(posted()).toBeNull()
}, T)

test('gh not logged in: a broker GH_TOKEN rides the gh env; without one the job fails with a notice', async () => {
  writeFileSync(join(fake, 'auth'), '1')
  const asked: string[] = []
  const withToken = service((n) => { asked.push(n); return n === 'GH_TOKEN' ? TEST_TOKEN : null })
  await drafted(withToken)
  expect(asked[0]).toBe('GH_TOKEN')
  expect(ghLog().filter((l) => l.startsWith('pr ')).every((l) => l.endsWith('token=set'))).toBe(true)
  expect(ghLog().join('\n')).not.toContain(TEST_TOKEN)

  const none = service()
  const job = none.start({ repo, pr: 7 })
  await none.settled(job.id)
  expect(none.jobs(repo)[0]?.status).toBe('failed')
  expect(none.jobs(repo)[0]?.error).toContain('gh auth login')
  expect(listInboxItems({ db, now: Date.now }).some((i) => i.title === 'PR #7 review failed')).toBe(true)
}, T)

test('a reviewer answer without findings JSON fails the job; zero findings is a notice, not a draft', async () => {
  setAnswer(null)
  const svc = service()
  const bad = svc.start({ repo, pr: 7 })
  await svc.settled(bad.id)
  expect(svc.jobs(repo)[0]).toMatchObject({ status: 'failed', error: 'the reviewer answered without a findings JSON array' })
  setAnswer([])
  const ok = svc.start({ repo, pr: 7 })
  await svc.settled(ok.id)
  expect(svc.jobs(repo)[0]).toMatchObject({ status: 'clean', findings: 0 })
  expect(getInboxItem(db, svc.jobs(repo)[0]!.itemId!)).toMatchObject({ kind: 'notify', title: 'PR #7 review: no findings' })
}, T)

test('poll reviews each new PR head once; a routine with the prreview action runs it', async () => {
  const svc = service()
  expect(await svc.poll({ repo })).toEqual({ reviewed: [7], skipped: 0 })
  expect(await svc.poll({ repo })).toEqual({ reviewed: [], skipped: 1 })
  expect(argvSeen).toHaveLength(1)

  const ctx = { db, now: Date.now }
  const store = createRoutineStore(ctx)
  const seen: unknown[] = []
  const runner = createRoutineRunner({
    ctx, store, record: () => {}, keepAwake: { acquire() {}, release() {} }, cwdOf: () => repo,
    spawn: () => Promise.reject(new Error('not used')), enqueue: async () => null, precheck: async () => ({ exitCode: 0, timedOut: false, error: null, output: '' }),
    prReview: async (input) => { seen.push(input); const r = await svc.poll(input); return `reviewed ${r.reviewed.length}` },
  })
  const routine = store.create({ name: 'PRs', enabled: true, workspaceId: null, trigger: { type: 'api' }, precheck: null, action: { type: 'prreview' }, budget: { maxRunsPerDay: 24, maxCostUsdPerDay: null } })
  const fired = runner.fire(routine, 'manual')
  await fired.done
  expect(seen).toEqual([{ repo, workspaceId: null, parent: `routine:${routine.id}` }])
  expect(store.lastRun(routine.id)).toMatchObject({ status: 'ran', reason: 'reviewed 0' })
}, T)

test('api: start is UI-only and validated; GET lists jobs and drafts', async () => {
  const svc = service()
  const deps = { service: svc, ctx: { db, now: Date.now }, isNodeToken: () => false, record: () => {} }
  expect((await handlePrReviewApi({ ...deps, isNodeToken: () => true }, req('POST', { 'x-webterm-token': 't' }), u('/api/prreview'), body({ repo, pr: 7 })))?.status).toBe(403)
  expect((await handlePrReviewApi(deps, req('POST', ui), u('/api/prreview'), body({ repo, pr: 0 })))?.status).toBe(400)
  const started = await handlePrReviewApi(deps, req('POST', ui), u('/api/prreview'), body({ repo, pr: 7 }))
  expect(started?.status).toBe(202)
  await svc.settled((started?.body as { id: string }).id)
  const list = await handlePrReviewApi(deps, req('GET'), u(`/api/prreview?repo=${encodeURIComponent(repo)}`), body({}))
  expect(list?.body).toMatchObject({ jobs: [{ pr: 7, status: 'drafted' }], drafts: [{ pr: 7 }] })
  expect(await handlePrReviewApi(deps, req('GET'), u('/api/other'), body({}))).toBeNull()
}, T)
