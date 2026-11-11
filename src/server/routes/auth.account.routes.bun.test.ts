// Locks for accounts on `/auth/*` (auth.routes.ts, auth.account.routes.ts): setup needs proof and
// races to one account, every sign-in mints a fresh cookie, login is throttled, the token stops
// signing humans in once an account exists, a user sees and revokes only their own sessions, a
// password change signs other devices out, and `/auth/open?next=` never leaves the origin.
// Real HTTP server, in-memory SQLite, tmp data dir, fake opener: no browser, no real data dir.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wt-accounts-'))
process.env.WEBTERM_DATA_DIR = dataDir // before ../uiSession -> ../db opens
const { createUiAuthRoute } = await import('./auth.routes')
const { createUiOpener } = await import('../uiOpen')
const { createUiSessionStore } = await import('../uiSession')
const { createUserStore } = await import('../uiUser')
const { BACKOFF_AFTER, createLoginThrottle } = await import('../loginThrottle')
const { ensureSetupCode, setupCodePath } = await import('../setupCode')
const { UI_SESSION_COOKIE } = await import('../auth')

const ROOT_TOKEN = 'root-token-test-only-0123456789abcdef' // test-only
const PW = 'correct horse battery' // test-only
const PW2 = 'another long passphrase' // test-only
let mem = new Database(':memory:')
let store = createUiSessionStore(mem)
let users = createUserStore(mem)
let opened: string[] = []
const opener = createUiOpener({ runDir: join(dataDir, 'run'), bindHost: '127.0.0.1', port: 1, openFile: async (p) => { opened.push(p) } })
const build = () => createUiAuthRoute({ sessions: () => store, users: () => users, opener, token: () => ROOT_TOKEN, dataDir: () => dataDir, throttle: createLoginThrottle() })
let route = build()

const server = http.createServer((req, res) => {
  if (!route(req, res, new URL(req.url ?? '/', 'http://x'))) { res.statusCode = 404; res.end() }
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
const SAME = { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', 'user-agent': 'TestBrowser/1.0' }
const EVIL = { origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' }
afterAll(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }) })

beforeEach(() => {
  mem = new Database(':memory:')
  store = createUiSessionStore(mem)
  users = createUserStore(mem)
  opened = []
  rmSync(setupCodePath(dataDir), { force: true })
  route = build()
})

interface Reply { status: number; headers: http.IncomingHttpHeaders; json: Record<string, unknown> }
function call(method: string, path: string, headers: Record<string, string> = SAME, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: text.startsWith('{') ? JSON.parse(text) : {} }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
const cookieOf = (r: Reply): string => {
  const raw = (r.headers['set-cookie'] ?? [])[0] ?? ''
  return raw.slice(`${UI_SESSION_COOKIE}=`.length, raw.indexOf(';'))
}
const as = (raw: string, h: Record<string, string> = SAME) => ({ ...h, cookie: `${UI_SESSION_COOKIE}=${raw}` })
const setupCode = (): string => readFileSync(ensureSetupCode(dataDir, users)!, 'utf8').trim()
/** Owner `alice` via the setup code; returns the session cookie. */
async function owner(): Promise<string> {
  const r = await call('POST', '/auth/setup', SAME, { username: 'alice', password: PW, setupCode: setupCode() })
  expect(r.status).toBe(201)
  return cookieOf(r)
}

describe('POST /auth/setup', () => {
  test('proof required: no cookie and no code 403, a wrong code 403, the code 201 + cookie for the user; code cleared', async () => {
    const code = setupCode()
    expect((await call('POST', '/auth/setup', SAME, { username: 'alice', password: PW })).json).toEqual({ error: 'setup_proof_required' })
    expect((await call('POST', '/auth/setup', SAME, { username: 'alice', password: PW, setupCode: 'f'.repeat(32) })).status).toBe(403)
    const r = await call('POST', '/auth/setup', SAME, { username: 'alice', password: PW, setupCode: code })
    expect(r.status).toBe(201)
    expect(r.json).toEqual({ user: { id: expect.any(Number), username: 'alice' } })
    expect(store.userOf(cookieOf(r))).toBe((r.json.user as { id: number }).id)
    expect(store.list()[0]!.ua).toBe('TestBrowser/1.0')
    expect(existsSync(setupCodePath(dataDir))).toBe(false)
    expect((await call('POST', '/auth/setup', SAME, { username: 'bob', password: PW, setupCode: code })).json).toEqual({ error: 'already_setup' })
  })

  test('a token-era session is proof; it is revoked and a fresh cookie is set', async () => {
    const proof = store.create()
    const r = await call('POST', '/auth/setup', as(proof), { username: 'alice', password: PW })
    expect(r.status).toBe(201)
    expect(cookieOf(r)).not.toBe(proof)
    expect(store.verify(proof)).toBe(false)
    expect(store.count()).toBe(1)
  })

  test('400 invalid_username / weak_password, and validation does not burn the code', async () => {
    const code = setupCode()
    expect((await call('POST', '/auth/setup', SAME, { username: 'a', password: PW, setupCode: code })).json).toEqual({ error: 'invalid_username' })
    expect((await call('POST', '/auth/setup', SAME, { username: 'alice', password: 'short', setupCode: code })).json).toEqual({ error: 'weak_password' })
    expect((await call('POST', '/auth/setup', SAME, { username: 'alice', password: PW, setupCode: code })).status).toBe(201)
  })

  test('two concurrent setups: exactly one 201, one 409', async () => {
    const [a, b] = [store.create(), store.create()]
    const rs = await Promise.all([
      call('POST', '/auth/setup', as(a), { username: 'alice', password: PW }),
      call('POST', '/auth/setup', as(b), { username: 'bob', password: PW }),
    ])
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409])
    expect(users.count()).toBe(1)
  })
})

describe('POST /auth/login', () => {
  test('200 { user } with a fresh cookie (the old one is revoked); 401 invalid_credentials; /auth/me shows the user', async () => {
    const first = await owner()
    const r = await call('POST', '/auth/login', as(first), { username: 'alice', password: PW })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ user: { id: expect.any(Number), username: 'alice' } })
    expect(cookieOf(r)).not.toBe(first)
    expect(store.verify(first)).toBe(false)
    expect((await call('POST', '/auth/login', SAME, { username: 'alice', password: 'wrong password!' })).json).toEqual({ error: 'invalid_credentials' })
    expect((await call('POST', '/auth/login', SAME, { username: 'nobody', password: PW })).status).toBe(401)
    expect((await call('GET', '/auth/me', as(cookieOf(r)))).json).toEqual({ signedIn: true, setupRequired: false, user: { id: expect.any(Number), username: 'alice' }, tokenSignIn: false })
  })

  test('throttled: after BACKOFF_AFTER failures 429 rate_limited with Retry-After, even with the right password', async () => {
    await owner()
    for (let i = 0; i < BACKOFF_AFTER; i++) expect((await call('POST', '/auth/login', SAME, { username: 'alice', password: 'nope nope nope' })).status).toBe(401)
    const r = await call('POST', '/auth/login', SAME, { username: 'alice', password: PW })
    expect(r.status).toBe(429)
    expect(r.json).toEqual({ error: 'rate_limited' })
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0)
  })

  test('the root token signs humans in only until an account exists', async () => {
    expect((await call('POST', '/auth/login', SAME, { token: ROOT_TOKEN })).status).toBe(204)
    await owner()
    expect((await call('POST', '/auth/login', SAME, { token: ROOT_TOKEN })).json).toEqual({ error: 'token_sign_in_disabled' })
  })

  test('cross-origin POSTs are refused before they act', async () => {
    const raw = await owner()
    for (const [path, body] of [['/auth/setup', { username: 'x', password: PW }], ['/auth/login', { username: 'alice', password: PW }],
      ['/auth/sessions/revoke-others', {}], ['/auth/account/password', { current: PW, next: PW2 }]] as const) {
      expect((await call('POST', path, as(raw, EVIL), body)).json).toEqual({ error: 'origin' })
    }
    expect(store.verify(raw)).toBe(true)
  })
})

describe('/auth/sessions', () => {
  test('lists only the caller\'s sessions; revoke one (never another user\'s); revoke-others; 401 signed out', async () => {
    const mine = await owner()
    const userId = store.userOf(mine)!
    const second = store.create({ userId })
    store.create({ userId: userId + 1 }) // another account's session
    const list = await call('GET', '/auth/sessions', as(mine))
    const items = list.json.items as { id: string; current: boolean; ua: string | null }[]
    expect(items.length).toBe(2)
    expect(items.filter((i) => i.current).length).toBe(1)
    const foreign = store.list().find((s) => s.userId === userId + 1)!.id
    expect((await call('POST', `/auth/sessions/${foreign}/revoke`, as(mine))).status).toBe(404)
    expect(store.list().some((s) => s.id === foreign)).toBe(true)
    const secondId = items.find((i) => !i.current)!.id
    expect((await call('POST', `/auth/sessions/${secondId}/revoke`, as(mine))).status).toBe(204)
    expect(store.verify(second)).toBe(false)
    store.create({ userId })
    store.create({ userId })
    expect((await call('POST', '/auth/sessions/revoke-others', as(mine))).json).toEqual({ revoked: 2 })
    expect(store.verify(mine)).toBe(true)
    expect(store.list().length).toBe(2) // mine + the other account's
    expect((await call('GET', '/auth/sessions', SAME)).json).toEqual({ error: 'not_signed_in' })
  })
})

describe('/auth/account', () => {
  test('password: 401 wrong current, 400 weak, 200 revokes every other session; the new password signs in', async () => {
    const mine = await owner()
    const other = store.create({ userId: store.userOf(mine)! })
    expect((await call('POST', '/auth/account/password', as(mine), { current: 'wrong password!', next: PW2 })).json).toEqual({ error: 'invalid_credentials' })
    expect((await call('POST', '/auth/account/password', as(mine), { current: PW, next: 'short' })).json).toEqual({ error: 'weak_password' })
    expect((await call('POST', '/auth/account/password', as(mine), { current: PW, next: PW2 })).status).toBe(200)
    expect(store.verify(mine)).toBe(true)
    expect(store.verify(other)).toBe(false)
    expect((await call('POST', '/auth/login', SAME, { username: 'alice', password: PW2 })).status).toBe(200)
  })

  test('username: 200 { user }, 409 username_taken, 401 wrong password', async () => {
    const mine = await owner()
    mem.query("INSERT INTO ui_user (username, pw_hash, created_at, pw_changed_at) VALUES ('bob', 'x', 0, 0)").run()
    expect((await call('POST', '/auth/account/username', as(mine), { username: 'bob', password: PW })).json).toEqual({ error: 'username_taken' })
    expect((await call('POST', '/auth/account/username', as(mine), { username: 'carol', password: 'wrong password!' })).status).toBe(401)
    const r = await call('POST', '/auth/account/username', as(mine), { username: 'carol', password: PW })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ user: { id: store.userOf(mine), username: 'carol' } })
  })
})

describe('GET /auth/open?next=', () => {
  const openWith = async (next: string): Promise<Reply> => {
    await opener.open()
    const code = /code=([A-Za-z0-9_-]+)/.exec(readFileSync(opened.at(-1)!, 'utf8'))![1]!
    return call('GET', `/auth/open?code=${code}&next=${encodeURIComponent(next)}`, {})
  }
  test('only a same-origin path is followed; the session is bound to the sole account', async () => {
    for (const bad of ['//evil.test', 'https://evil.test', '/\\evil.test', 'javascript:alert(1)', '/a\nb']) {
      expect((await openWith(bad)).headers.location).toBe('/')
    }
    await owner()
    const r = await openWith('/ok?x=1')
    expect(r.status).toBe(303)
    expect(r.headers.location).toBe('/ok?x=1')
    expect(store.userOf(cookieOf(r))).not.toBe(null)
  })
})
