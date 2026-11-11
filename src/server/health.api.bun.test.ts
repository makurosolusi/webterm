// GET /api/health on a real server: `{bootId, build}` with the root token, 403 without one (the
// client's auth probe turns that into the `auth` phase), and a new bootId per process start.
// Plus the build id: `dev` in dev mode, a dist/index.html hash otherwise.
import { afterAll, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pkg from '../../package.json'
import { HEALTH_PATH } from '../shared/protocol'
import { TOKEN_HEADER } from './auth'
import { createServerIdentity } from './health.api'
import { reapChildren } from './processReap.testutil'

const ENTRY = join(import.meta.dirname, 'index.ts')
const READY_TIMEOUT_MS = 15_000
const POLL_MS = 100
const TOKEN = 'health-test-token-'.repeat(3) // test-only
const children: ChildProcess[] = []
afterAll(() => { children.forEach((c) => c.kill()); return reapChildren() })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function freePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address() as AddressInfo
  await new Promise<void>((r) => srv.close(() => r()))
  return port
}

/** Boot a server and wait until /api/health answers; returns its base URL and process. */
async function boot(): Promise<{ base: string; proc: ChildProcess }> {
  const dir = mkdtempSync(join(tmpdir(), 'wt-health-'))
  const port = await freePort()
  const proc = spawn(process.execPath, ['--no-env-file', ENTRY], {
    cwd: dir, env: { HOME: dir, WEBTERM_DATA_DIR: join(dir, 'data'), PORT: String(port), WEBTERM_TOKEN: TOKEN }, stdio: ['ignore', 'ignore', 'ignore'],
  })
  children.push(proc)
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error('server did not come up in time')
    try { await fetch(`${base}${HEALTH_PATH}`); return { base, proc } } catch { await sleep(POLL_MS) }
  }
}

test('health answers bootId + build with the token, 403 without it, and a restart changes bootId', async () => {
  const a = await boot()
  expect((await fetch(`${a.base}${HEALTH_PATH}`)).status).toBe(403)
  expect((await fetch(`${a.base}${HEALTH_PATH}`, { headers: { [TOKEN_HEADER]: 'wrong' } })).status).toBe(403)
  const ok = await fetch(`${a.base}${HEALTH_PATH}`, { headers: { [TOKEN_HEADER]: TOKEN } })
  expect(ok.status).toBe(200)
  expect(ok.headers.get('cache-control')).toBe('no-store')
  const first = (await ok.json()) as { bootId: string; build: string }
  expect(first.bootId).toMatch(/^[0-9a-f-]{36}$/)
  expect(first.build).toBe(`${pkg.version}+dev`)

  const b = await boot()
  const second = (await (await fetch(`${b.base}${HEALTH_PATH}`, { headers: { [TOKEN_HEADER]: TOKEN } })).json()) as { bootId: string }
  expect(second.bootId).not.toBe(first.bootId)
}, 2 * READY_TIMEOUT_MS + 5_000)

test('build id: dev mode says dev; production hashes dist/index.html and follows a rebuild', () => {
  const dist = mkdtempSync(join(tmpdir(), 'wt-dist-'))
  expect(createServerIdentity({ distDir: dist, dev: true }).build).toBe(`${pkg.version}+dev`)
  expect(createServerIdentity({ distDir: dist, dev: false }).build).toBe(`${pkg.version}+dev`) // no build on disk
  writeFileSync(join(dist, 'index.html'), '<script src="/assets/index-aaa.js"></script>')
  const one = createServerIdentity({ distDir: dist, dev: false }).build
  expect(one).toMatch(new RegExp(`^${pkg.version.replace(/\./g, '\\.')}\\+[0-9a-f]{10}$`))
  writeFileSync(join(dist, 'index.html'), '<script src="/assets/index-bbb.js"></script>')
  expect(createServerIdentity({ distDir: dist, dev: false }).build).not.toBe(one)
})
