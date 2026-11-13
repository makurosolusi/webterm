// Single instance per data dir (nativeSession.ts): a running server -> attach + signed-in window, none ->
// start in-process, stale record (dead pid) -> start in-process; quitting while attached leaves the external
// server running. The window only ever gets a file path: no output line of ours carries `code=`.
import { afterAll, expect, test } from 'bun:test'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INSTANCE_FILE, readInstanceFile } from '../server/instanceFile'
import { reapChildren } from '../server/processReap.testutil'
import { freeLoopbackPort, LOOPBACK_HOST } from './embeddedServer'

const MODULE = join(import.meta.dirname, 'nativeSession.ts')
const SERVER_ENTRY = join(import.meta.dirname, '../server/index.ts')
const STEP_TIMEOUT_MS = 20_000
const POLL_MS = 100
const children: ChildProcess[] = []
afterAll(() => { children.forEach((c) => c.kill()); return reapChildren() })

// Child: the app's flow without Electrobun; `quit` on stdin = the app quitting.
const CHILD = `
import { openNativeSession } from ${JSON.stringify(MODULE)}
const s = await openNativeSession({ showSignInFile: (p) => console.log('SHOW ' + p) })
console.log('MODE ' + s.mode + ' ' + s.origin)
for await (const line of console) if (line === 'quit') { await s.quit(); console.log('QUIT'); process.exit(0) }
`

interface Proc { proc: ChildProcess; out: () => string }

function tempDirs(): { dir: string; data: string; run: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'wt-native-'))
  const data = join(dir, 'data')
  // test-only: every path temp, never the real ~/.webterm-server or ~/.claude
  return { dir, data, run: join(data, 'run'), env: { PATH: process.env.PATH ?? '', HOME: dir, WEBTERM_DATA_DIR: data, CLAUDE_CONFIG_DIR: join(dir, 'claude'), NODE_ENV: 'test' } }
}

function launch(args: string[], cwd: string, env: Record<string, string>): Proc {
  const proc = spawn(process.execPath, ['--no-env-file', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(proc)
  let text = ''
  for (const s of [proc.stdout, proc.stderr]) s?.on('data', (c: Buffer) => void (text += c.toString()))
  return { proc, out: () => text }
}

async function until<T>(what: string, probe: () => T | null | undefined, p: Proc): Promise<T> {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const v = probe()
    if (v !== null && v !== undefined) return v
    if (p.proc.exitCode !== null) throw new Error(`process exited (${p.proc.exitCode}) before ${what}; output: ${p.out()}`)
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  throw new Error(`no ${what} in time; output: ${p.out()}`)
}

const lineOf = (p: Proc, prefix: string): Promise<string> =>
  until(`"${prefix}" line`, () => p.out().split('\n').find((l) => l.startsWith(prefix))?.slice(prefix.length), p)

/** The app quits: QUIT printed, then the process exits by itself. */
async function quit(p: Proc): Promise<void> {
  const exited = new Promise((r) => p.proc.once('exit', r))
  p.proc.stdin?.write('quit\n')
  await lineOf(p, 'QUIT')
  await exited
}

/** Trade the sign-in file's one-time code for the UI cookie, as the window's meta-refresh would. */
async function signInWith(file: string): Promise<string> {
  const url = /url=([^"]+)"/.exec(readFileSync(file, 'utf8'))![1]!.replace(/&amp;/g, '&')
  const res = await fetch(url, { redirect: 'manual' })
  expect(res.status).toBe(303)
  return res.headers.get('set-cookie')?.split(';')[0] ?? ''
}

test('a running server for the data dir: attach, signed-in window, quitting leaves that server running', async () => {
  const t = tempDirs()
  const port = await freeLoopbackPort()
  const external = launch([SERVER_ENTRY], t.dir, { ...t.env, HOST: LOOPBACK_HOST, PORT: String(port) })
  await until('instance record', () => readInstanceFile(t.run), external)

  const app = launch(['-e', CHILD], t.dir, t.env)
  expect(await lineOf(app, 'MODE ')).toBe(`attached http://${LOOPBACK_HOST}:${port}`)
  const file = await lineOf(app, 'SHOW ')
  expect(file).toBe(join(t.run, `open-${external.proc.pid}.html`)) // the external server's file
  const cookie = await signInWith(file)
  const me = await fetch(`http://${LOOPBACK_HOST}:${port}/auth/me`, { headers: { cookie } })
  expect((await me.json() as { signedIn: boolean }).signedIn).toBe(true)

  await quit(app)
  expect(external.proc.exitCode).toBeNull()
  expect((await fetch(`http://${LOOPBACK_HOST}:${port}/auth/me`)).status).toBe(200)
  expect(readInstanceFile(t.run)?.pid).toBe(external.proc.pid)
  expect(app.out()).not.toContain('code=')
}, 4 * STEP_TIMEOUT_MS)

test('no server for the data dir: start in-process, record it, drop the record on quit', async () => {
  const t = tempDirs()
  const app = launch(['-e', CHILD], t.dir, t.env)
  const [mode, origin] = (await lineOf(app, 'MODE ')).split(' ')
  expect(mode).toBe('embedded')
  const rec = readInstanceFile(t.run)
  expect(rec?.pid).toBe(app.proc.pid)
  expect(origin).toBe(`http://${LOOPBACK_HOST}:${rec?.port}`)
  expect((await signInWith(await lineOf(app, 'SHOW '))).startsWith('wt_ui=')).toBe(true)
  await quit(app)
  expect(existsSync(join(t.run, INSTANCE_FILE))).toBe(false)
  expect(app.out()).not.toContain('code=')
}, 3 * STEP_TIMEOUT_MS)

test('a stale record (its process is dead): start in-process and take the record over', async () => {
  const t = tempDirs()
  const dead = spawnSync('true').pid // exited and reaped: nothing runs under this pid now
  mkdirSync(t.run, { recursive: true, mode: 0o700 })
  writeFileSync(join(t.run, INSTANCE_FILE), JSON.stringify({ pid: dead, host: LOOPBACK_HOST, port: await freeLoopbackPort() }), { mode: 0o600 })
  const app = launch(['-e', CHILD], t.dir, t.env)
  expect((await lineOf(app, 'MODE ')).split(' ')[0]).toBe('embedded')
  expect(app.out()).toContain(`recorded server pid ${dead} is not running`)
  expect(readInstanceFile(t.run)?.pid).toBe(app.proc.pid)
  await quit(app)
}, 3 * STEP_TIMEOUT_MS)
