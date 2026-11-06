// Lock over the REAL HTTP stack: the cookie-only webterm page (it never sends the root token header)
// can change Settings and capabilities, and nothing else gets through the settings guard. A webterm
// server process (index.ts) runs on a temp HOME / data dir / Claude config dir; Claude is never
// launched (Central stays off). Token and cookie values are never printed.
import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAPABILITY_HEADER, TOKEN_HEADER, UI_SESSION_COOKIE } from './auth'
import { CONTROL_EFFECTIVE_PATH } from './envSettings.control'
import { ENV_SETTINGS_PATH, IMPORT_ENDPOINT } from './envSettings.api'
import { createPolicyStore } from './policy/policy.store'

const ENTRY = join(import.meta.dirname, 'index.ts')
const READY_TIMEOUT_MS = 15_000
const dir = mkdtempSync(join(tmpdir(), 'guard-http-'))
const data = join(dir, 'data')
const children: ChildProcess[] = []
afterAll(() => {
  children.forEach((c) => c.kill())
  rmSync(dir, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address() as AddressInfo
  await new Promise<void>((r) => srv.close(() => r()))
  return port
}

const port = await freePort()
const base = `http://127.0.0.1:${port}`
const rootToken = crypto.randomUUID() // test-only
// test-only env: everything under the temp dir, never ~/.claude or ~/.webterm-server.
const server = spawn(process.execPath, ['--no-env-file', ENTRY], {
  cwd: dir,
  env: { HOME: dir, PATH: process.env.PATH ?? '', WEBTERM_DATA_DIR: data, CLAUDE_CONFIG_DIR: join(dir, 'claude'), PORT: String(port), WEBTERM_TOKEN: rootToken },
  stdio: ['ignore', 'pipe', 'pipe'],
})
children.push(server)
let log = ''
for (const s of [server.stdout, server.stderr]) s?.on('data', (c: Buffer) => void (log += c.toString()))
const deadline = Date.now() + READY_TIMEOUT_MS
for (;;) {
  if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode}): ${log.slice(-2000)}`)
  try { await fetch(`${base}/healthz-probe`); break } catch { /* not up yet */ }
  if (Date.now() > deadline) throw new Error('server did not come up in time')
  await new Promise((r) => setTimeout(r, 100))
}

// The page's credential, minted the way a remote browser signs in (root token -> HttpOnly cookie).
const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ token: rootToken }) })
if (login.status !== 204) throw new Error(`login failed: ${login.status}`)
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
if (!cookie.startsWith(`${UI_SESSION_COOKIE}=`)) throw new Error('login set no wt_ui cookie')

// A node token the running server accepts (issued in its own ledger, as mcp.e2e.bun.test.ts does).
const ledger = new Database(join(data, 'ledger.db'))
ledger.exec('PRAGMA busy_timeout = 5000')
const nodeToken = createPolicyStore(ledger, Date.now).issueToken('node:fake1')
;(ledger as unknown as { close(): void }).close() // the local bun:sqlite shim omits close

/** What the signed-in page sends: the cookie and its own Origin, nothing else. */
const PAGE = { cookie, origin: base }

/** One mutation per client surface the cookie-only Settings UI drives through the settings guard. */
const MUTATIONS: Array<{ name: string; method: string; path: string; body: unknown }> = [
  { name: 'settings env PUT', method: 'PUT', path: ENV_SETTINGS_PATH, body: { set: {}, unset: [] } },
  { name: 'settings env import (dry run)', method: 'POST', path: IMPORT_ENDPOINT, body: {} },
  { name: 'feature capability toggle', method: 'POST', path: '/api/capabilities/browser', body: { enabled: false } },
  { name: 'Control tab write', method: 'PUT', path: CONTROL_EFFECTIVE_PATH, body: { set: {}, unset: [] } },
]

const send = (m: (typeof MUTATIONS)[number], headers: Record<string, string>) =>
  fetch(`${base}${m.path}`, { method: m.method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(m.body) })

for (const m of MUTATIONS) describe(m.name, () => {
  test('cookie-only, same-origin: 200', async () => {
    expect((await send(m, PAGE)).status).toBe(200)
  })

  test('no cookie: 403', async () => {
    expect((await send(m, { origin: base })).status).toBe(403)
  })

  test('node token, alone or beside the cookie: 403', async () => {
    expect((await send(m, { origin: base, [TOKEN_HEADER]: nodeToken })).status).toBe(403)
    expect((await send(m, { ...PAGE, [TOKEN_HEADER]: nodeToken })).status).toBe(403)
  })

  test('capability header beside the cookie: 403', async () => {
    expect((await send(m, { ...PAGE, [CAPABILITY_HEADER]: 'wcap_forged' })).status).toBe(403)
  })

  test('cookie with a foreign Origin: 403', async () => {
    expect((await send(m, { ...PAGE, origin: 'http://evil.example' })).status).toBe(403)
  })

  test('root token header (operator script): 200', async () => {
    expect((await send(m, { [TOKEN_HEADER]: rootToken })).status).toBe(200)
  })
})

test('Control tab read: the cookie alone reads (a same-origin GET carries no Origin); no cookie is 403', async () => {
  expect((await fetch(`${base}${CONTROL_EFFECTIVE_PATH}`, { headers: { cookie } })).status).toBe(200)
  expect((await fetch(`${base}${CONTROL_EFFECTIVE_PATH}`)).status).toBe(403)
})
