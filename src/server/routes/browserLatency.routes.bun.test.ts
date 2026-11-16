// GET /api/browser/latency through the REAL router behind the same gate server.main.ts puts on /api.
import { afterAll, expect, test } from 'bun:test'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'wt-lat-'))
process.env.WEBTERM_DATA_DIR = root // before ../api -> ../db opens
process.env.HOME = root // test-only: nothing may land in the real home dir
const { handleApi } = await import('../api')
const { authorizeRequest, TOKEN_HEADER } = await import('../auth')
const { refuseRequest } = await import('../bootWiring')
const { activeLatency, createLatencyRecorder, setActiveLatency } = await import('../browser/browserAgent.latency')

const TOKEN = 'test-only-root-token'
const original = activeLatency()
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const ok = authorizeRequest({ headers: req.headers, expectedToken: TOKEN, pathname: url.pathname, isNodeToken: () => false })
  if (!ok) return refuseRequest(res)
  if (!handleApi(req, res)) { res.statusCode = 404; res.end() }
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
afterAll(() => { server.close(); setActiveLatency(original) })
const get = (qs = '', headers: Record<string, string> = { [TOKEN_HEADER]: TOKEN }): Promise<Response> => fetch(`http://127.0.0.1:${port}/api/browser/latency${qs}`, { headers })

test('refused without a credential, 400 on a bad sinceMs, 503 without a recorder, 200 with the summary', async () => {
  expect((await get('', {})).status).toBe(403)
  expect((await get('', { [TOKEN_HEADER]: 'wrong' })).status).toBe(403)
  for (const bad of ['?sinceMs=abc', '?sinceMs=-5', '?sinceMs=0', '?sinceMs=1.5', '?sinceMs=99999999999999', '?sinceMs=']) expect((await get(bad)).status).toBe(400)

  setActiveLatency(null)
  expect((await get()).status).toBe(503)

  const rec = createLatencyRecorder()
  setActiveLatency(rec)
  await rec.timed('navigate', async () => 1, { url: 'https://a.test/secret/path?q=SECRET' })
  const res = await get('?sinceMs=60000')
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).not.toMatch(/secret|a\.test/i)
  expect(JSON.parse(text)).toMatchObject({ verbs: { navigate: { count: 1, okRate: 1 } } })
})
