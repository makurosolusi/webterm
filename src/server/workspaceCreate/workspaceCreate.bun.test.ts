// Clone runner against a fake `git` (emits progress, creates the folder, sleeps or fails on cue) and
// New project against real git, all under a temp dir. Never touches the user's repos or HOME.
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateError, abortClone, cloneRepo, createProject } from './workspaceCreate'
import { workspaceCreateRoute } from './workspaceCreate.route'

const TEST_TIMEOUT_MS = 30_000
let tmp: string
let fakeGit: string
let argvLog: string

// test-only: argv goes to a log; "slowrepo" sleeps (cancel window), "authfail" fails like GitHub auth does.
const FAKE_GIT = `#!/bin/sh
printf '%s\\n' "$@" > "$ARGV_LOG"
for a; do target="$a"; done
mkdir -p "$target" && echo hi > "$target/README.md"
printf 'Receiving objects:  10%% (1/10)\\r' >&2
printf 'Receiving objects:  100%% (10/10), done.\\n' >&2
case "$*" in
  *slowrepo*) printf 'Resolving deltas:  50%% (1/2)\\n' >&2; sleep 30 ;;
  *authfail*) echo "fatal: Authentication failed for 'https://bob:s3cret@github.com/o/authfail.git/'" >&2; exit 128 ;;
esac
exit 0
`

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wsc-')))
  fakeGit = join(tmp, 'fake-git')
  argvLog = join(tmp, 'argv.log')
  writeFileSync(fakeGit, FAKE_GIT)
  chmodSync(fakeGit, 0o755)
  process.env.ARGV_LOG = argvLog
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 't'
  for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 't@t'
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: CreateError) => e.code)
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25)) }

test('clone streams progress, passes the URL after --, and blocks file/ext protocols', async () => {
  const seen: string[] = []
  const path = await cloneRepo({ url: 'owner/repo', parent: tmp }, (p) => seen.push(`${p.phase} ${p.percent}`), { git: fakeGit })
  expect(path).toBe(join(tmp, 'repo'))
  expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('hi\n')
  expect(seen).toContain('Receiving objects 100')
  expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual([
    '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', 'clone', '--progress', '--', 'https://github.com/owner/repo.git', join(tmp, 'repo'),
  ])
}, TEST_TIMEOUT_MS)

test('clone uses the edited folder name and makes a missing parent', async () => {
  const parent = join(tmp, 'a', 'b')
  expect(await cloneRepo({ url: 'git@github.com:o/r.git', parent, name: 'mine' }, () => {}, { git: fakeGit })).toBe(join(parent, 'mine'))
}, TEST_TIMEOUT_MS)

test('cancel kills the clone and removes the partial folder', async () => {
  const p = cloneRepo({ url: 'https://example.com/o/slowrepo.git', parent: tmp }, () => {}, { git: fakeGit })
  await until(() => existsSync(join(tmp, 'slowrepo', 'README.md')))
  expect(abortClone()).toBe(true)
  expect(await codeOf(p)).toBe('aborted')
  expect(existsSync(join(tmp, 'slowrepo'))).toBe(false)
  expect(abortClone()).toBe(false) // idle again
}, TEST_TIMEOUT_MS)

test('auth failure reads as gh auth login and never echoes the credential', async () => {
  const err = await cloneRepo({ url: 'https://github.com/o/authfail.git', parent: tmp }, () => {}, { git: fakeGit }).catch((e: CreateError) => e)
  expect((err as CreateError).code).toBe('git_failed')
  expect((err as CreateError).message).toContain('gh auth login')
  expect((err as CreateError).message).not.toContain('s3cret')
  expect(existsSync(join(tmp, 'authfail'))).toBe(false) // failure cleans up too
}, TEST_TIMEOUT_MS)

test('non-empty target is refused and left alone', async () => {
  mkdirSync(join(tmp, 'repo'))
  writeFileSync(join(tmp, 'repo', 'keep.txt'), 'mine')
  expect(await codeOf(cloneRepo({ url: 'o/repo', parent: tmp }, () => {}, { git: fakeGit }))).toBe('exists')
  expect(readFileSync(join(tmp, 'repo', 'keep.txt'), 'utf8')).toBe('mine')
  expect(await codeOf(createProject({ parent: tmp, name: 'repo' }))).toBe('exists')
})

test('traversal, relative parents and unsafe URLs are refused before anything runs', async () => {
  for (const name of ['..', '../x', 'a/b', '.']) expect(await codeOf(createProject({ parent: tmp, name }))).toBe('bad_request')
  expect(await codeOf(createProject({ parent: 'relative/dir', name: 'x' }))).toBe('bad_request')
  expect(await codeOf(cloneRepo({ url: 'o/r', parent: tmp, name: '../escape' }, () => {}, { git: fakeGit }))).toBe('bad_request')
  for (const url of ['file:///etc', 'ext::sh -c id', '--upload-pack=touch /tmp/x', '/local/repo'])
    expect(await codeOf(cloneRepo({ url, parent: tmp }, () => {}, { git: fakeGit }))).toBe('bad_request')
  expect(existsSync(argvLog)).toBe(false)
})

test('new project makes the folder with .git and an initial commit; gitInit false skips git', async () => {
  const path = await createProject({ parent: tmp, name: 'fresh' })
  expect(existsSync(join(path, '.git', 'HEAD'))).toBe(true)
  const log = execFileSync('git', ['-C', path, 'log', '--format=%s'], { encoding: 'utf8' }).trim()
  expect(log).toBe('Initial commit')
  const plain = await createProject({ parent: tmp, name: 'plain', gitInit: false })
  expect(existsSync(plain)).toBe(true)
  expect(existsSync(join(plain, '.git'))).toBe(false)
}, TEST_TIMEOUT_MS)

test('nothing is created inside the data dir, whatever the dialog said', async () => {
  const dataDir = join(tmp, 'data')
  expect(await codeOf(createProject({ parent: dataDir, name: 'p', gitInit: false }, { dataDir }))).toBe('bad_request')
  expect(await codeOf(cloneRepo({ url: 'o/r', parent: join(dataDir, 'x') }, () => {}, { git: fakeGit, dataDir }))).toBe('bad_request')
  expect(existsSync(dataDir)).toBe(false)
  expect(existsSync(argvLog)).toBe(false)
})

// --- route ---------------------------------------------------------------------------------------

function fakeRes() {
  const r = { statusCode: 0, chunks: [] as string[], headers: {} as Record<string, string>, writableEnded: false, listeners: [] as (() => void)[] }
  const res = {
    get statusCode() { return r.statusCode }, set statusCode(v: number) { r.statusCode = v },
    get writableEnded() { return r.writableEnded },
    setHeader: (k: string, v: string) => { r.headers[k.toLowerCase()] = v },
    write: (s: string) => { r.chunks.push(s); return true },
    end: (s?: string) => { if (s) r.chunks.push(s); r.writableEnded = true; r.listeners.forEach((l) => l()) },
    on: (ev: string, l: () => void) => { if (ev === 'close') r.listeners.push(l); return res },
  }
  return { res: res as unknown as ServerResponse, r }
}
const uiReq = (method: string, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE, host: 'localhost:8700', origin: 'http://localhost:8700' }) =>
  ({ method, headers }) as unknown as IncomingMessage
// test-only: injected HOME / data dir under tmp, so the real ~/webterm is never resolved or made.
const env = () => ({ home: join(tmp, 'home'), dataDir: join(tmp, 'home', '.webterm-server'), configured: '' })
let revealed: string[][] = []
const call = async (req: IncomingMessage, path: string, body: unknown = {}) => {
  const { res, r } = fakeRes()
  const handled = await workspaceCreateRoute(req, res, new URL(path, 'http://x'), async () => JSON.stringify(body), {
    git: fakeGit, isNodeToken: (t) => t === 'node-tok', env: async () => env(), workspaces: async () => [],
    reveal: { platform: 'darwin', spawn: async (c, a) => { revealed.push([c, ...a]) } },
  })
  return { handled, ...r }
}

test('agent token gets 403 on every verb; nothing is created', async () => {
  for (const path of ['/api/workspace-create/defaults', '/api/workspace-create/project', '/api/workspace-create/clone',
    '/api/workspace-create/check', '/api/workspace-create/reveal', '/api/workspace-create/projects-folder/check']) {
    const out = await call(uiReq('POST', { 'x-webterm-token': 'node-tok', 'sec-fetch-site': 'same-origin' }), path, { parent: tmp, name: 'x', url: 'o/x' })
    expect(out.statusCode).toBe(403)
    expect(out.chunks.join('')).toContain('agent_cannot_create_workspaces')
  }
  expect((await call(uiReq('POST', {}), '/api/workspace-create/project', { parent: tmp, name: 'x' })).statusCode).toBe(403) // plain curl
  expect(existsSync(join(tmp, 'x'))).toBe(false)
})

test('route: clone streams NDJSON ending in done; project answers 201; errors keep a status', async () => {
  const clone = await call(uiReq('POST'), '/api/workspace-create/clone', { url: 'o/streamed', parent: tmp })
  const lines = clone.chunks.join('').trim().split('\n').map((l) => JSON.parse(l))
  expect(clone.headers['content-type']).toBe('application/x-ndjson')
  expect(lines.some((l) => l.type === 'progress' && l.percent === 100)).toBe(true)
  expect(lines.at(-1)).toEqual({ type: 'done', path: join(tmp, 'streamed') })

  const proj = await call(uiReq('POST'), '/api/workspace-create/project', { parent: tmp, name: 'np', gitInit: false })
  expect(proj.statusCode).toBe(201)
  expect(JSON.parse(proj.chunks.join(''))).toEqual({ path: join(tmp, 'np') })

  const bad = await call(uiReq('POST'), '/api/workspace-create/clone', { url: 'file:///etc', parent: tmp })
  expect(bad.statusCode).toBe(400)
  const notOurs = await call(uiReq('GET'), '/api/workspaces')
  expect(notOurs.handled).toBe(false)
}, TEST_TIMEOUT_MS)

test('route: defaults, projects-folder check, preflight and reveal', async () => {
  const def = await call(uiReq('GET'), `/api/workspace-create/defaults?remembered=${encodeURIComponent(join(tmp, 'gone'))}`)
  const projects = join(tmp, 'home', 'webterm', 'projects')
  expect(JSON.parse(def.chunks.join(''))).toEqual({ parent: projects, projectsFolder: projects, builtin: projects })
  expect(existsSync(projects)).toBe(false) // resolved, not made

  expect((await call(uiReq('POST'), '/api/workspace-create/projects-folder/check', { path: 'rel/dir' })).statusCode).toBe(400)
  expect((await call(uiReq('POST'), '/api/workspace-create/projects-folder/check', { path: join(tmp, 'home', '.webterm-server', 'p') })).statusCode).toBe(400)
  expect((await call(uiReq('POST'), '/api/workspace-create/projects-folder/check', { path: join(tmp, 'code') })).statusCode).toBe(200)

  mkdirSync(join(tmp, 'taken'))
  writeFileSync(join(tmp, 'taken', 'f'), '')
  const pre = await call(uiReq('POST'), '/api/workspace-create/check', { parent: tmp, name: 'taken' })
  expect(JSON.parse(pre.chunks.join(''))).toMatchObject({ target: join(tmp, 'taken'), taken: true, suggestion: 'taken-2' })
  expect((await call(uiReq('POST'), '/api/workspace-create/check', { parent: tmp, name: '../x' })).statusCode).toBe(400)

  // The default folder is made on first real use (mkdir -p of the parent).
  expect((await call(uiReq('POST'), '/api/workspace-create/project', { parent: projects, name: 'one', gitInit: false })).statusCode).toBe(201)
  expect(existsSync(join(projects, 'one'))).toBe(true)
  const inData = await call(uiReq('POST'), '/api/workspace-create/project', { parent: join(tmp, 'home', '.webterm-server'), name: 'x', gitInit: false })
  expect(inData.statusCode).toBe(400)

  revealed = []
  expect((await call(uiReq('POST'), '/api/workspace-create/reveal', { path: join(projects, 'one') })).statusCode).toBe(200)
  expect(revealed).toEqual([['open', '-R', join(projects, 'one')]])
  expect((await call(uiReq('POST'), '/api/workspace-create/reveal', { path: join(tmp, 'nope') })).statusCode).toBe(400)
  expect((await call(uiReq('POST'), '/api/workspace-create/reveal', { path: 'relative' })).statusCode).toBe(400)
  expect(revealed).toHaveLength(1)
}, TEST_TIMEOUT_MS)
