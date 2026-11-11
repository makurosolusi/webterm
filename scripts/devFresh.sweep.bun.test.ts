import { afterAll, expect, test } from 'bun:test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { supervisorSocket } from '../src/server/ptySupervisor'
import { findOnPath } from '../src/server/binaryOnPath'
import { makeFreshRoot } from './devFresh'
import {
  NO_OWNER_STALE_MS, OWNER_FILE, ROOT_ARG, claudeKeychainServices, deleteClaudeKeychain, parseOwner, rootProcesses, staleReason,
  sweepStale, writeOwner, type FreshOwner, type KeychainRunner, type Proc,
} from './devFresh.sweep'
import { fakeSecurity } from './devFresh.testutil'

// test-only: every root lives in a temp base, never the real tmpdir.
const base = mkdtempSync(join(tmpdir(), 'dfs-'))
const kids: ChildProcess[] = []
afterAll(() => {
  for (const k of kids) try { if (k.pid) process.kill(-k.pid, 'SIGKILL') } catch { /* already gone */ }
  rmSync(base, { recursive: true, force: true })
})
const deadPid = () => spawnSync('true').pid! // exited: a pid nobody owns (any reuse is not a dev:fresh script)
const owner = (root: string, o: Partial<FreshOwner> = {}): FreshOwner => ({
  pid: deadPid(), childPid: 99999, pgid: 99999, tmuxSocket: 'webterm-x', claudeConfigDir: join(root, 'claude'), createdAt: '2026-01-01T00:00:00Z', keep: false, ...o,
})
const recorder = () => { const calls: string[][] = []; const run: KeychainRunner = (a) => { calls.push(a); return { status: 44, stderr: '' } }; return { calls, run } }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (ok: () => boolean, ms: number) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return ok() }

test('owner.json parses; garbage or missing fields count as no owner', () => {
  const o = owner('/r')
  expect(parseOwner(JSON.stringify(o))).toEqual(o)
  expect(parseOwner('{')).toBe(null)
  expect(parseOwner(JSON.stringify({ ...o, pid: 'x' }))).toBe(null)
  expect(parseOwner(JSON.stringify({ ...o, keep: undefined }))?.keep).toBe(false)
})

test('stale decision: live owner never stale; no owner only after an hour', () => {
  const o = owner('/r')
  expect(staleReason({ owner: o, ownerAlive: true, ageMs: 10 * NO_OWNER_STALE_MS })).toBe(null)
  expect(staleReason({ owner: o, ownerAlive: false, ageMs: 0 })).toBe('owner_dead')
  expect(staleReason({ owner: null, ownerAlive: false, ageMs: NO_OWNER_STALE_MS - 1 })).toBe(null)
  expect(staleReason({ owner: null, ownerAlive: false, ageMs: NO_OWNER_STALE_MS + 1 })).toBe('no_owner')
})

test('keychain service names match Claude Code for a known config dir', () => {
  // sha256('/tmp/st/webterm-fresh-1-abc/claude') starts a1ac1c8e (python hashlib)
  expect(claudeKeychainServices('/tmp/st/webterm-fresh-1-abc/claude')).toEqual(['Claude Code-credentials-a1ac1c8e', 'Claude Code-a1ac1c8e'])
})

test('keychain delete: exact -s names, not-found is silent, other OSes do nothing', () => {
  const r = recorder()
  deleteClaudeKeychain('/x/claude', r.run, 'darwin')
  expect(r.calls.map((a) => [a[0], a.at(-2), a.at(-1)])).toEqual(claudeKeychainServices('/x/claude').map((s) => ['delete-generic-password', '-s', s]))
  expect(r.calls.flat()).not.toContain('-w')
  const linux = recorder()
  deleteClaudeKeychain('/x/claude', linux.run, 'linux')
  expect(linux.calls).toEqual([])
})

test('sweep never deletes keychain items of a config dir outside the root (the real Claude login)', async () => {
  const own = mkdtempSync(join(base, 'kc-'))
  const real = makeFreshRoot(own)
  const blank = makeFreshRoot(own)
  const empty = makeFreshRoot(own)
  writeOwner(real.root, owner(real.root, { claudeConfigDir: '/Users/me/.claude' })) // test-only: a tampered/old owner.json
  writeOwner(blank.root, owner(blank.root, { claudeConfigDir: '' })) // default mode: real HOME, no own config dir
  writeOwner(empty.root, owner(empty.root, { claudeConfigDir: empty.claude })) // --empty-home
  const k = recorder()
  const r = await sweepStale({ tmpBase: own, keychain: k.run })
  expect(r.cleaned.length).toBe(3)
  const hashes = k.calls.map((c) => c.at(-1))
  for (const s of claudeKeychainServices('/Users/me/.claude')) expect(hashes).not.toContain(s)
  expect(hashes).toEqual(process.platform === 'darwin' ? claudeKeychainServices(empty.claude) : [])
})

test('process ownership: argv marker or Chromium profile; the group only when proven; never a sibling root', () => {
  const root = '/t/webterm-fresh-1-abc'
  const procs: Proc[] = [
    { pid: 10, pgid: 10, command: `bun src/server/index.ts ${ROOT_ARG}${root}` },
    { pid: 11, pgid: 10, command: 'Chromium Helper --type=renderer' },
    { pid: 12, pgid: 12, command: `chrome --user-data-dir=${root}/data/browser/profiles/w1 --foo` },
    { pid: 13, pgid: 13, command: `bun src/server/index.ts ${ROOT_ARG}${root}d` }, // another root sharing the prefix
    { pid: 14, pgid: 14, command: 'vim notes.txt' },
  ]
  expect(rootProcesses(procs, root, 10).sort()).toEqual([10, 11, 12])
  expect(rootProcesses(procs, root, 14).sort()).toEqual([10, 12]) // pgid 14 has no proven member: left alone
  expect(rootProcesses(procs, root, 10, 10).sort()).toEqual([11, 12]) // never ourselves
})

test('sweep: stale root loses its processes, tmux server, keychain items and files; live and young roots stay', async () => {
  const stale = makeFreshRoot(base)
  // A fake server (argv marker) with a child in its group that carries no marker.
  const srv = spawn('/bin/sh', ['-c', 'sleep 60; true', 'sh', `${ROOT_ARG}${stale.root}`], { detached: true, stdio: 'ignore' })
  kids.push(srv)
  writeOwner(stale.root, owner(stale.root, { childPid: srv.pid!, pgid: srv.pid! }))
  await until(() => spawnSync('pgrep', ['-g', String(srv.pid)], { encoding: 'utf8' }).stdout.trim().split('\n').length >= 2, 3000)
  const groupKids = spawnSync('pgrep', ['-g', String(srv.pid)], { encoding: 'utf8' }).stdout.trim().split('\n').map(Number)
  expect(groupKids.length).toBe(2)
  const tmux = findOnPath('tmux')
  const sock = supervisorSocket(stale.data)
  if (tmux) spawnSync(tmux, ['-L', sock, 'new-session', '-d', '-s', 't', 'sleep 600'], { env: { ...process.env, TMUX: '' } })

  const live = makeFreshRoot(base)
  const liveOwner = spawn('/bin/sh', ['-c', 'sleep 60; true', 'devFresh-owner'], { detached: true, stdio: 'ignore' })
  kids.push(liveOwner)
  writeOwner(live.root, owner(live.root, { pid: liveOwner.pid! }))
  const young = makeFreshRoot(base) // no owner.json, just made: may be a run that is still booting
  const kept = makeFreshRoot(base)
  writeOwner(kept.root, owner(kept.root, { keep: true }))
  mkdirSync(join(base, 'not-fresh'))
  await until(() => spawnSync('pgrep', ['-f', 'devFresh-owner']).status === 0, 3000)

  const k = recorder()
  const r = await sweepStale({ tmpBase: base, keychain: k.run })
  expect(r.cleaned).toEqual([stale.root])
  expect(r.kept).toEqual([kept.root])
  expect(r.live.map((l) => l.root)).toEqual([live.root])
  expect(r.failed).toEqual([])
  expect(existsSync(stale.root)).toBe(false)
  for (const p of groupKids) expect(alive(p)).toBe(false)
  if (tmux) expect(spawnSync(tmux, ['-L', sock, 'has-session']).status).not.toBe(0)
  expect(k.calls.map((a) => a.at(-1)).sort()).toEqual([...claudeKeychainServices(stale.claude), ...claudeKeychainServices(kept.claude)].sort())
  for (const p of [live, young, kept]) expect(existsSync(p.root)).toBe(true)
  expect(existsSync(join(kept.root, OWNER_FILE))).toBe(true)
  expect(existsSync(join(base, 'not-fresh'))).toBe(true)
  expect(alive(liveOwner.pid!)).toBe(true)

  // An hour later the ownerless root is judged stale too.
  const later = await sweepStale({ tmpBase: base, keychain: k.run, now: Date.now() + NO_OWNER_STALE_MS + 60_000 })
  expect(later.cleaned).toEqual([young.root])
  expect(existsSync(live.root)).toBe(true)
  process.kill(-liveOwner.pid!, 'SIGKILL')
  rmSync(live.root, { recursive: true, force: true })
  rmSync(kept.root, { recursive: true, force: true })
}, 30_000)

const fakeBin = join(base, 'bin')
mkdirSync(fakeBin)
const securityCalls = fakeSecurity(fakeBin)
const scriptEnv = { ...process.env, TMPDIR: base, PATH: `${fakeBin}:${process.env.PATH}` }
const script = join(import.meta.dirname, 'devFresh.ts')

test('--clean reports and removes a stale root, lists a live one and leaves it', async () => {
  const stale = makeFreshRoot(base)
  writeOwner(stale.root, owner(stale.root))
  const live = makeFreshRoot(base)
  const liveOwner = spawn('/bin/sh', ['-c', 'sleep 60; true', 'devFresh-owner2'], { detached: true, stdio: 'ignore' })
  kids.push(liveOwner)
  writeOwner(live.root, owner(live.root, { pid: liveOwner.pid! }))
  await until(() => spawnSync('pgrep', ['-f', 'devFresh-owner2']).status === 0, 3000)
  const r = spawnSync(process.execPath, ['--no-env-file', script, '--clean'], { env: scriptEnv, encoding: 'utf8' })
  expect(r.status).toBe(0)
  expect(r.stdout).toContain('cleaned 1 stale fresh instance(s)')
  expect(r.stdout).toContain(`live, left running: ${live.root}`)
  expect(existsSync(stale.root)).toBe(false)
  expect(existsSync(live.root)).toBe(true)
  expect(securityCalls()).toContain(claudeKeychainServices(stale.claude)[0])
  process.kill(-liveOwner.pid!, 'SIGKILL')
  rmSync(live.root, { recursive: true, force: true })
}, 30_000)

const smoke = process.env.CI && !findOnPath('tmux') ? 'skip' : 'run'
test(`SIGKILL of dev:fresh (${smoke}): its server stops by itself and cleans root + tmux server`, async () => {
  if (smoke === 'skip') return
  const p = spawn(process.execPath, ['--no-env-file', script, '--empty-home'], { env: scriptEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  kids.push(p)
  let out = ''
  p.stdout!.on('data', (b) => { out += String(b) })
  p.stderr!.on('data', (b) => { out += String(b) })
  expect(await until(() => /Temp root:\s+(\S+)/.test(out), 60_000)).toBe(true)
  const root = /Temp root:\s+(\S+)/.exec(out)![1]
  const o = parseOwner(readFileSync(join(root, OWNER_FILE), 'utf8'))!
  expect(o.pid).toBe(p.pid!)
  const tmux = findOnPath('tmux')
  if (tmux) spawnSync(tmux, ['-L', o.tmuxSocket, 'new-session', '-d', '-s', 't', 'sleep 600'], { env: { ...process.env, TMUX: '' } })

  process.kill(p.pid!, 'SIGKILL')
  expect(await until(() => !alive(o.childPid), 6000)).toBe(true) // watchdog polls every 2 s
  expect(await until(() => !existsSync(root), 10_000)).toBe(true)
  if (tmux) expect(spawnSync(tmux, ['-L', o.tmuxSocket, 'has-session']).status).not.toBe(0)
  expect(securityCalls()).toContain(claudeKeychainServices(join(root, 'claude'))[0])
}, 90_000)
