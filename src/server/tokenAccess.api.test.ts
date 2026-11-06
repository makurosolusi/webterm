// Token opt-in (EM-15): enable/rotate/GET lewat rute nyata, data dir mkdtemp, nol nilai token di log/GET.
import { TEST_UI_COOKIE } from './uiSession.testutil'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authorizeRequest } from './auth'
import { TOKEN_BODY_MAX_BYTES, tokenAccessRoute } from './tokenAccess.api'
import { envSettingsRoute } from './envSettings.api'
import { settingsGuard } from './featureCapabilities.guard'
import { fakeReq, recorder, setupEnv, type RecordedRes } from './envSettings.testutil'
import { forgetNodeToken, nodeToken } from './hooksTokens'
import { logBus } from './logs'
import { getTokenState, setTokenState, tokenFilePath } from './tokenBootstrap'

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/
const LOOPBACK = '127.0.0.1'
const LAN_PEER = '10.0.0.5'
const GET_PATH = '/api/settings/token'
const ENABLE = `${GET_PATH}/enable`
const ROTATE = `${GET_PATH}/rotate`
const NONE = { token: undefined, source: 'none', created: false } as const
/** Bentuk permintaan fetch() dari halaman webterm sendiri (fetch metadata + Origin sama). */
const BROWSER = { host: `${LOOPBACK}:8700`, origin: `http://${LOOPBACK}:8700`, 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE }

let root: string
let secretsDir: string
const savedEnvToken = process.env.WEBTERM_TOKEN

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'webterm-tokenaccess-'))
  secretsDir = join(root, 'secrets')
  setTokenState(NONE)
  delete process.env.WEBTERM_TOKEN
  logBus.clear()
})

afterEach(() => {
  setTokenState(NONE)
  if (savedEnvToken === undefined) delete process.env.WEBTERM_TOKEN
  else process.env.WEBTERM_TOKEN = savedEnvToken
  rmSync(root, { recursive: true, force: true })
})

interface Reply { res: RecordedRes; json: Record<string, any> }

/** Satu panggilan rute; selesai saat respons ditulis (rute berjalan async di balik boolean). */
function call(method: string, path: string, opts: { peer?: string; body?: string; dir?: string; headers?: Record<string, string>; installed?: (req: IncomingMessage) => void } = {}): Promise<Reply> {
  const req = Object.assign(fakeReq(method, opts.body), {
    socket: { remoteAddress: opts.peer ?? LOOPBACK },
    headers: opts.headers ?? BROWSER,
  }) as unknown as IncomingMessage
  const res = recorder()
  return new Promise((resolve) => {
    res.end = ((chunk?: string) => {
      if (chunk) res.body += chunk
      resolve({ res, json: res.body ? (res.json() as Record<string, any>) : {} })
    }) as typeof res.end
    expect(tokenAccessRoute(req, res, path, opts.dir ?? secretsDir, opts.installed)).toBe(true)
  })
}

/** Gerbang auth nyata (seperti index.ts) terhadap token yang berlaku saat ini. */
function gate(candidate?: string): boolean {
  return authorizeRequest({
    headers: { host: `${LOOPBACK}:8700`, ...(candidate ? { 'x-webterm-token': candidate } : {}) },
    expectedToken: getTokenState().token,
    pathname: '/api/anything',
    isNodeToken: () => false,
  })
}

const logText = (): string => JSON.stringify(logBus.snapshot())
const mentions = (haystack: string, secret: string): boolean => haystack.includes(secret)

describe('POST /api/settings/token/enable', () => {
  it('peer loopback + source none: bangkitkan, simpan 0600, tegakkan, nilai sekali tanpa cache', async () => {
    const { res, json } = await call('POST', ENABLE)
    expect(res.status).toBe(200)
    expect(TOKEN_SHAPE.test(json.token)).toBe(true)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(res.headers.Pragma).toBe('no-cache')
    const file = tokenFilePath(secretsDir)
    expect(readFileSync(file, 'utf8')).toBe(json.token)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(getTokenState()).toMatchObject({ token: json.token, source: 'file' })
    expect(process.env.WEBTERM_TOKEN).toBe(json.token)
    expect(gate()).toBe(false)
    expect(gate(json.token)).toBe(true)
  })

  it('dua kali dan konkuren: tepat satu menang, yang kalah 409 already_enabled', async () => {
    const [a, b] = await Promise.all([call('POST', ENABLE), call('POST', ENABLE)])
    const statuses = [a.res.status, b.res.status].sort()
    expect(statuses).toEqual([200, 409])
    const loser = a.res.status === 409 ? a : b
    const winner = a.res.status === 200 ? a : b
    expect(loser.json).toEqual({ error: 'already_enabled' })
    expect(readdirSync(secretsDir)).toEqual(['WEBTERM_TOKEN'])
    expect(getTokenState().token).toBe(winner.json.token)
    expect((await call('POST', ENABLE)).res.status).toBe(409)
  })

  it('peer non-loopback: 403 loopback_only, X-Forwarded-For diabaikan, state tak berubah', async () => {
    const { res, json } = await call('POST', ENABLE, { peer: LAN_PEER, headers: { ...BROWSER, 'x-forwarded-for': LOOPBACK } })
    expect(res.status).toBe(403)
    expect(json).toEqual({ error: 'loopback_only' })
    expect(getTokenState().source).toBe('none')
    expect(process.env.WEBTERM_TOKEN).toBeUndefined()
  })

  it.each(['::1', '::ffff:127.0.0.1'])('peer %s dianggap loopback', async (peer) => {
    expect((await call('POST', ENABLE, { peer })).res.status).toBe(200)
  })

  it('gagal tulis: 500 token_persist_failed, source tetap none, tak ada berkas, log tanpa token', async () => {
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'bukan direktori')
    const { res, json } = await call('POST', ENABLE, { dir: join(blocker, 'secrets') })
    expect(res.status).toBe(500)
    expect(json).toEqual({ error: 'token_persist_failed' })
    expect(getTokenState().source).toBe('none')
    expect(process.env.WEBTERM_TOKEN).toBeUndefined()
    expect(readdirSync(root)).toEqual(['blocker'])
    expect(logText()).toContain('auth.token_persist_failed')
  })

  it('body melebihi TOKEN_BODY_MAX_BYTES: 413 tanpa efek', async () => {
    const { res } = await call('POST', ENABLE, { body: 'x'.repeat(TOKEN_BODY_MAX_BYTES + 1) })
    expect(res.status).toBe(413)
    expect(getTokenState().source).toBe('none')
  })

  it('method selain POST: 405', async () => {
    expect((await call('GET', ENABLE)).res.status).toBe(405)
  })

  it('log mencatat auth.token_enabled dan tidak memuat nilai token di seluruh alur', async () => {
    const { json } = await call('POST', ENABLE)
    const rotated = await call('POST', ROTATE)
    const text = logText()
    expect(text).toContain('auth.token_enabled')
    expect(mentions(text, json.token)).toBe(false)
    expect(mentions(text, rotated.json.token)).toBe(false)
  })
})

describe('POST /api/settings/token/rotate', () => {
  it('source file: token baru, lama langsung tak berlaku, berkas dan env tersinkron', async () => {
    const first = (await call('POST', ENABLE)).json.token as string
    const { res, json } = await call('POST', ROTATE)
    expect(res.status).toBe(200)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(json.token).not.toBe(first)
    expect(TOKEN_SHAPE.test(json.token)).toBe(true)
    expect(gate(first)).toBe(false)
    expect(gate(json.token)).toBe(true)
    expect(readFileSync(tokenFilePath(secretsDir), 'utf8')).toBe(json.token)
    expect(process.env.WEBTERM_TOKEN).toBe(json.token)
  })

  it('a new token signs other UI sessions out: the hook runs once per install, never on a refusal', async () => {
    const seen: IncomingMessage[] = []
    const installed = (req: IncomingMessage) => { seen.push(req) }
    await call('POST', ENABLE, { installed })
    await call('POST', ROTATE, { installed })
    expect(seen.length).toBe(2)
    setTokenState({ token: 'e'.repeat(40), source: 'env', created: false })
    await call('POST', ROTATE, { installed })
    expect(seen.length).toBe(2)
  })

  it('source env: 409 env_managed dan berkas tidak dibuat', async () => {
    setTokenState({ token: 'e'.repeat(40), source: 'env', created: false })
    const { res, json } = await call('POST', ROTATE)
    expect(res.status).toBe(409)
    expect(json).toEqual({ error: 'env_managed' })
    expect(readdirSync(root)).toEqual([])
  })

  it('source none: 409 not_enabled', async () => {
    const { res, json } = await call('POST', ROTATE)
    expect(res.status).toBe(409)
    expect(json).toEqual({ error: 'not_enabled' })
  })

  it('enable pada source env: 409 already_enabled', async () => {
    setTokenState({ token: 'e'.repeat(40), source: 'env', created: false })
    expect((await call('POST', ENABLE)).json).toEqual({ error: 'already_enabled' })
  })
})

describe('enable/rotate hanya dari UI (bukan agent / curl)', () => {
  it('curl tanpa fetch metadata: 403 approval_browser_only, token tidak dibuat', async () => {
    const { res, json } = await call('POST', ENABLE, { headers: { host: BROWSER.host } })
    expect([res.status, json]).toEqual([403, { error: 'approval_browser_only' }])
    expect(getTokenState().source).toBe('none')
    expect(readdirSync(root)).toEqual([])
  })

  it('Origin asing atau cross-site: 403 approval_browser_only', async () => {
    const foreign = await call('POST', ENABLE, { headers: { ...BROWSER, origin: 'http://evil.test' } })
    expect(foreign.json).toEqual({ error: 'approval_browser_only' })
    const cross = await call('POST', ENABLE, { headers: { host: BROWSER.host, 'sec-fetch-site': 'cross-site' } })
    expect(cross.json).toEqual({ error: 'approval_browser_only' })
    expect(getTokenState().source).toBe('none')
  })

  it('token node sesi agent, walau fetch metadata benar: 403 agent_cannot_approve', async () => {
    const agent = nodeToken('node-tokenaccess-test')
    try {
      const { res, json } = await call('POST', ENABLE, { headers: { ...BROWSER, 'x-webterm-token': agent } })
      expect([res.status, json]).toEqual([403, { error: 'agent_cannot_approve' }])
      expect(getTokenState().source).toBe('none')
    } finally {
      forgetNodeToken('node-tokenaccess-test')
    }
  })

  it('header capability: 403 agent_cannot_approve, juga untuk rotate', async () => {
    const enable = await call('POST', ENABLE, { headers: { ...BROWSER, 'x-webterm-capability': 'wcap_x' } })
    expect([enable.res.status, enable.json]).toEqual([403, { error: 'agent_cannot_approve' }])
    await call('POST', ENABLE)
    const rotate = await call('POST', ROTATE, { headers: { host: BROWSER.host } })
    expect([rotate.res.status, rotate.json]).toEqual([403, { error: 'approval_browser_only' }])
  })
})

describe('GET /api/settings/token', () => {
  it('tanpa nilai; canEnable hanya source none + peer loopback', async () => {
    const open = await call('GET', GET_PATH)
    expect(open.json).toEqual({ enforced: false, source: 'none', canEnable: true })
    expect((await call('GET', GET_PATH, { peer: LAN_PEER })).json.canEnable).toBe(false)

    const { json: enabled } = await call('POST', ENABLE)
    const after = await call('GET', GET_PATH)
    expect(after.json).toEqual({ enforced: true, source: 'file', canEnable: false })
    expect(mentions(after.res.body, enabled.token)).toBe(false)
  })

  it('method selain GET: 405; path lain bukan milik rute ini', async () => {
    expect((await call('POST', GET_PATH)).res.status).toBe(405)
    const req = { method: 'GET', socket: { remoteAddress: LOOPBACK } } as unknown as IncomingMessage
    expect(tokenAccessRoute(req, recorder(), '/api/settings', secretsDir)).toBe(false)
  })
})

describe('efek ke kunci dangerous (settingsGuard)', () => {
  const SAME = { host: `${LOOPBACK}:8700`, origin: `http://${LOOPBACK}:8700` }
  const put = async (headers: Record<string, string>) => {
    const s = setupEnv({})
    const res = recorder()
    const body = JSON.stringify({ set: { WEBTERM_OPENCODE_BIN: '/bin/sh' } })
    const req = Object.assign(fakeReq('PUT', body), { headers, socket: { remoteAddress: LOOPBACK } }) as unknown as IncomingMessage
    await envSettingsRoute(req, res, 'PUT', { service: s.svc, guard: (r) => settingsGuard(r, {}) })
    return res
  }

  it('tanpa token ditegakkan: tanpa Origin 403 forbidden; loopback + Origin sama lolos', async () => {
    const denied = await put({ host: SAME.host })
    expect([denied.status, denied.json()]).toEqual([403, { error: 'forbidden' }])
    expect((await put(SAME)).status).toBe(200)
  })

  it('sesudah enable: tanpa token 403 forbidden, token root lolos tanpa Origin', async () => {
    const { json } = await call('POST', ENABLE)
    expect((await put(SAME)).status).toBe(403)
    expect((await put({ 'x-webterm-token': 'salah' })).status).toBe(403)
    expect((await put({ 'x-webterm-token': json.token })).status).toBe(200)
  })
})
