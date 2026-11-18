// POST /api/link-open: identity comes only from the credential, never from the body; switch/browser states answer clearly.
import { mkdtempSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setActiveBrowser } from '../browser/browser.state'
import type { BrowserRuntime } from '../browser/browser.state'
import { forgetNodeToken, nodeToken } from '../hooksTokens'
import { TOKEN_HEADER } from '../auth'
import { ENV_CAPTURE_LINKS, LINK_OPEN_PATH, LINK_TOKEN_HEADER } from './linkCapture.config'
import { linkCredential } from './linkCapture.identity'
import { linkOpenRoute } from './linkCapture.route'

process.env.WEBTERM_DATA_DIR = mkdtempSync(join(tmpdir(), 'wt-linkroute-'))

let opened: Array<[string, unknown]>
let reply: { status: number; body: Record<string, unknown> }
beforeEach(() => {
  opened = []
  reply = { status: 200, body: { ok: true, mode: 'canvas', nodeId: 'nb1' } }
  setActiveBrowser({ openLink: async (origin: string, url: unknown) => { opened.push([origin, url]); return reply } } as unknown as BrowserRuntime)
})
afterEach(() => { setActiveBrowser(null); forgetNodeToken('agent1') })

async function call(headers: Record<string, string>, body: string, opts: { method?: string; path?: string; env?: Record<string, string> } = {}) {
  const out = { status: 0, body: '' }
  const res = { statusCode: 0, setHeader() {}, end(b?: string) { out.status = res.statusCode; out.body = b ?? '' } }
  const req = { method: opts.method ?? 'POST', headers } as unknown as IncomingMessage
  const handled = await linkOpenRoute(req, res as unknown as ServerResponse, new URL(opts.path ?? LINK_OPEN_PATH, 'http://x'), async () => body, { WEBTERM_BROWSER: 'on', ...opts.env })
  return { handled, status: out.status, json: out.body ? JSON.parse(out.body) : undefined }
}
const asTerminal = (id: string) => ({ [LINK_TOKEN_HEADER]: linkCredential(id) })

describe('POST /api/link-open', () => {
  it('opens the link for the node the credential names, whatever the body claims', async () => {
    const r = await call(asTerminal('term1'), JSON.stringify({ url: 'https://a.example/', nodeId: 'someone-else', workspaceId: 'w9' }))
    expect(r).toMatchObject({ handled: true, status: 200, json: { mode: 'canvas' } })
    expect(opened).toEqual([['term1', 'https://a.example/']])
  })

  it('an agent session may use its node token instead', async () => {
    await call({ [TOKEN_HEADER]: nodeToken('agent1') }, JSON.stringify({ url: 'https://a.example/' }))
    expect(opened).toEqual([['agent1', 'https://a.example/']])
  })

  it.each([[{}], [{ [LINK_TOKEN_HEADER]: 'bad.term1' }], [{ [TOKEN_HEADER]: 'not-a-node-token' }]])('no valid identity = 401 and nothing opens', async (headers) => {
    const r = await call(headers, JSON.stringify({ url: 'https://a.example/' }))
    expect(r.status).toBe(401)
    expect(opened).toEqual([])
  })

  it('only POST, and only its own path', async () => {
    expect((await call(asTerminal('term1'), '', { method: 'GET' })).status).toBe(405)
    expect((await call(asTerminal('term1'), '', { path: '/api/other' })).handled).toBe(false)
  })

  it('switch off: a session started earlier is told to use the machine opener, and nothing opens in the canvas', async () => {
    const r = await call(asTerminal('term1'), JSON.stringify({ url: 'https://a.example/' }), { env: { [ENV_CAPTURE_LINKS]: 'off' } })
    expect(r.json).toEqual({ ok: true, mode: 'machine' })
    expect(opened).toEqual([])
  })

  it('browser feature off: a visible 503, never a quiet machine-browser fallback', async () => {
    setActiveBrowser(null)
    const r = await call(asTerminal('term1'), JSON.stringify({ url: 'https://a.example/' }))
    expect(r).toMatchObject({ status: 503, json: { error: 'browser_off' } })
  })

  it('a refusal from the browser side passes through with its status and message', async () => {
    reply = { status: 409, body: { error: 'max_live', message: 'full' } }
    expect(await call(asTerminal('term1'), JSON.stringify({ url: 'https://a.example/' }))).toMatchObject({ status: 409, json: { message: 'full' } })
  })

  it('a body that is not JSON is a 400', async () => {
    expect((await call(asTerminal('term1'), '{nope')).status).toBe(400)
  })
})
