// sec-208-1 / sec-208-3 locks for the `wt_ui` UI session (routes/auth.routes.ts, uiOpen.ts, uiSession.ts):
// a one-time code in a 0600 file -> HttpOnly cookie, never a secret in a URL, a response body or argv.
// Real HTTP server, in-memory SQLite, tmp data dir, a fake opener: no browser is ever launched.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'wt-uisession-'))
process.env.WEBTERM_DATA_DIR = dataDir // before ../uiSession -> ../db opens
const { createUiAuthRoute, OPEN_INTERVAL_MS, revokeOtherSessions } = await import('./auth.routes')
const { CODE_TTL_MS, autoOpenAtBoot, createUiOpener } = await import('../uiOpen')
const { SESSION_IDLE_MS, createUiSessionStore } = await import('../uiSession')
const { UI_SESSION_COOKIE } = await import('../auth')

const ROOT_TOKEN = 'root-token-test-only-0123456789abcdef' // test-only
const runDir = join(dataDir, 'run')
let clock = 1_000_000
const now = () => clock
let mem = new Database(':memory:')
let store = createUiSessionStore(mem, now)
let opened: string[] = []
let token: string | undefined = ROOT_TOKEN
const opener = createUiOpener({ runDir, bindHost: '127.0.0.1', port: 1, now, openFile: async (p) => { opened.push(p) } })
let route = createUiAuthRoute({ sessions: () => store, opener, token: () => token, now })

const server = http.createServer((req, res) => {
  if (!route(req, res, new URL(req.url ?? '/', 'http://x'))) { res.statusCode = 404; res.end() }
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
const SAME = { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' }
afterAll(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }) })

beforeEach(() => {
  clock += OPEN_INTERVAL_MS + CODE_TTL_MS // fresh rate-limit window, any earlier code expired
  mem = new Database(':memory:')
  store = createUiSessionStore(mem, now)
  opened = []
  token = ROOT_TOKEN
  route = createUiAuthRoute({ sessions: () => store, opener, token: () => token, now })
})

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }
function call(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** Ask the server for a window and read the code out of the redirect file, as the browser would. */
async function mintCode(): Promise<string> {
  await opener.open()
  const m = /\/auth\/open\?code=([A-Za-z0-9_-]+)/.exec(readFileSync(opened.at(-1)!, 'utf8'))
  if (!m) throw new Error('redirect file holds no /auth/open?code= link')
  return m[1]!
}
const cookieOf = (r: Reply): string => {
  const raw = (r.headers['set-cookie'] ?? [])[0] ?? ''
  return raw.slice(`${UI_SESSION_COOKIE}=`.length, raw.indexOf(';'))
}
const withCookie = (v: string) => ({ ...SAME, cookie: `${UI_SESSION_COOKIE}=${v}` })

describe('GET /auth/open: one-time code -> HttpOnly cookie', () => {
  test('303 to a clean `/`, cookie HttpOnly + SameSite=Strict + Path=/, no secret in the body', async () => {
    const r = await call('GET', `/auth/open?code=${await mintCode()}`)
    expect(r.status).toBe(303)
    expect(r.headers.location).toBe('/')
    expect(r.headers['cache-control']).toBe('no-store')
    const set = r.headers['set-cookie']![0]!
    expect(set.startsWith(`${UI_SESSION_COOKIE}=`)).toBe(true)
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/']) expect(set).toContain(`; ${attr}`)
    expect(set).not.toContain('Secure') // plain http on loopback must keep the cookie
    expect(r.body).toBe('')
    expect(store.verify(cookieOf(r))).toBe(true)
  })

  test('a code is single use, a wrong code and an expired code are refused', async () => {
    const code = await mintCode()
    expect((await call('GET', `/auth/open?code=${code}`)).status).toBe(303)
    expect((await call('GET', `/auth/open?code=${code}`)).status).toBe(403)
    await mintCode()
    expect((await call('GET', `/auth/open?code=${'A'.repeat(43)}`)).status).toBe(403)
    expect((await call('GET', '/auth/open')).status).toBe(403)
    const late = await mintCode()
    clock += CODE_TTL_MS + 1
    const r = await call('GET', `/auth/open?code=${late}`)
    expect(r.status).toBe(403)
    expect(r.headers['set-cookie']).toBe(undefined)
    expect(store.count()).toBe(1) // only the first, valid open
  })

  test('the store keeps only sha256(cookie): a copied webterm.db holds no usable value', async () => {
    const raw = cookieOf(await call('GET', `/auth/open?code=${await mintCode()}`))
    const rows = mem.query('SELECT * FROM ui_session').all() as Record<string, unknown>[]
    expect(rows.length).toBe(1)
    expect(JSON.stringify(rows)).not.toContain(raw)
    expect(rows[0]!.hash).toBe(createHash('sha256').update(raw).digest('hex'))
  })
})

describe('GET /auth/me and session lifetime', () => {
  test('signedIn follows a live cookie; 30 days idle ends it', async () => {
    expect(JSON.parse((await call('GET', '/auth/me')).body)).toEqual({ signedIn: false })
    const raw = store.create()
    expect(JSON.parse((await call('GET', '/auth/me', withCookie(raw))).body)).toEqual({ signedIn: true })
    clock += SESSION_IDLE_MS + 1
    expect(JSON.parse((await call('GET', '/auth/me', withCookie(raw))).body)).toEqual({ signedIn: false })
    expect(store.count()).toBe(0)
  })

  test('token enable/rotate revokes every session but the caller', () => {
    const mine = store.create()
    const other = store.create()
    revokeOtherSessions(() => store)({ headers: { cookie: `${UI_SESSION_COOKIE}=${mine}` } } as http.IncomingMessage)
    expect(store.verify(mine)).toBe(true)
    expect(store.verify(other)).toBe(false)
  })
})

describe('POST /auth/request-open: the server opens the window, the code never leaves the machine', () => {
  test('202 without the code; the opener gets a 0600 file path only; 1 per 10 s', async () => {
    const r = await call('POST', '/auth/request-open', SAME)
    expect(r.status).toBe(202)
    expect(JSON.parse(r.body)).toEqual({ opening: true })
    expect(opened.length).toBe(1)
    const file = opened[0]!
    expect(file.startsWith(`${runDir}/`)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(runDir).mode & 0o777).toBe(0o700)
    const code = /code=([A-Za-z0-9_-]+)/.exec(readFileSync(file, 'utf8'))![1]!
    expect(file).not.toContain(code) // argv (visible in `ps`) carries the path, never the code
    expect(r.body).not.toContain(code)
    const again = await call('POST', '/auth/request-open', SAME)
    expect(again.status).toBe(429)
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0)
    expect(opened.length).toBe(1)
    expect((await call('GET', `/auth/open?code=${code}`)).status).toBe(303)
  })

  test('a cross-site page cannot drive it', async () => {
    expect((await call('POST', '/auth/request-open', { origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await call('POST', '/auth/request-open', { origin: `http://127.0.0.1:${port + 1}` })).status).toBe(403)
    expect(opened.length).toBe(0)
  })
})

describe('POST /auth/login: root token -> cookie (remote sign-in)', () => {
  test('right token 204 + cookie, wrong token 403, cross-origin 403, token-free bind 409', async () => {
    const ok = await call('POST', '/auth/login', SAME, JSON.stringify({ token: ROOT_TOKEN }))
    expect(ok.status).toBe(204)
    expect(store.verify(cookieOf(ok))).toBe(true)
    expect((await call('POST', '/auth/login', SAME, JSON.stringify({ token: 'nope' }))).status).toBe(403)
    expect((await call('POST', '/auth/login', SAME, '{')).status).toBe(400)
    expect((await call('POST', '/auth/login', { origin: 'http://evil.test' }, JSON.stringify({ token: ROOT_TOKEN }))).status).toBe(403)
    token = undefined
    expect((await call('POST', '/auth/login', SAME, JSON.stringify({ token: ROOT_TOKEN }))).status).toBe(409)
    expect(store.count()).toBe(1)
  })
})

describe('POST /auth/logout: sign out ends this session only', () => {
  test('revokes the caller, clears the cookie, leaves other sessions; cross-origin 403', async () => {
    const mine = store.create()
    const other = store.create()
    expect((await call('POST', '/auth/logout', { origin: 'http://evil.test', cookie: `${UI_SESSION_COOKIE}=${mine}` })).status).toBe(403)
    expect(store.verify(mine)).toBe(true)
    const r = await call('POST', '/auth/logout', withCookie(mine))
    expect(r.status).toBe(204)
    const set = r.headers['set-cookie']![0]!
    expect(set.startsWith(`${UI_SESSION_COOKIE}=;`)).toBe(true)
    expect(set).toContain('Max-Age=0')
    expect(store.verify(mine)).toBe(false)
    expect(store.verify(other)).toBe(true)
  })
})

describe('autoOpenAtBoot: one tab on a data dir with no session, never from a non-TTY', () => {
  const spy = () => {
    let calls = 0
    return { calls: () => calls, opener: { open: async () => { calls++ }, consume: () => false } }
  }
  test('empty store + TTY opens once; a session row or piped stdio opens nothing; a broken store does not throw', async () => {
    const a = spy()
    expect(await autoOpenAtBoot({ sessionCount: () => store.count(), opener: a.opener, interactive: true })).toBe('opened')
    expect(a.calls()).toBe(1)
    store.create()
    const b = spy()
    expect(await autoOpenAtBoot({ sessionCount: () => store.count(), opener: b.opener, interactive: true })).toBe('has_sessions')
    const c = spy()
    expect(await autoOpenAtBoot({ sessionCount: () => 0, opener: c.opener, interactive: false })).toBe('not_interactive')
    expect(b.calls() + c.calls()).toBe(0)
    expect(await autoOpenAtBoot({ sessionCount: () => { throw new Error('db locked') }, opener: c.opener, interactive: true })).toBe('failed')
  })
})
