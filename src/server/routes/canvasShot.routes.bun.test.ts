// POST /api/canvas-shot/<reqId> over a REAL http server: magic-byte sniff, size cap, unknown and
// already-answered ids, client error reports, and the human-UI gate through the real route table.
import { afterAll, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.WEBTERM_DATA_DIR = mkdtempSync(join(tmpdir(), 'wt-canvasshot-')) // before ../api -> ../db opens
const { createShotBroker } = await import('../canvas/shotBroker')
const { CANVAS_SHOT_PREFIX, MAX_SHOT_BYTES, canvasShotRoute } = await import('./canvasShot.routes')
const { handleApi } = await import('../api')
const { TEST_UI_COOKIE } = await import('../uiSession.testutil')

const frames: string[] = []
const broker = createShotBroker({ broadcast: (m) => { frames.push(m.reqId) }, timeoutMs: 2000 })

const listen = async (s: Server): Promise<string> => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`
}
const direct = createServer((req, res) => {
  const path = new URL(req.url || '/', 'http://x').pathname
  void canvasShotRoute({ req, res, path, method: req.method || 'GET' }, broker).then((hit) => { if (!hit) { res.statusCode = 404; res.end() } })
})
const routed = createServer((req, res) => { if (!handleApi(req, res)) { res.statusCode = 404; res.end() } })
const base = await listen(direct)
const apiBase = await listen(routed)
afterAll(() => { direct.close(); routed.close() })

// test-only: smallest headers that pass the magic-byte sniff.
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8)])

const post = (id: string, body: Buffer | string, type = 'image/jpeg', at = base, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${at}${CANVAS_SHOT_PREFIX}${id}`, { method: 'POST', body: typeof body === 'string' ? body : new Uint8Array(body), headers: { 'content-type': type, ...headers } })
/** Starts a request and returns its id plus the pending result. */
const start = () => { const p = broker.request(800); return { id: frames.at(-1) as string, p } }

describe('canvas-shot upload route', () => {
  test('accepts jpeg (204) and the waiting request gets base64 of the exact bytes', async () => {
    const { id, p } = start()
    expect((await post(id, JPG)).status).toBe(204)
    expect(await p).toEqual({ ok: true, mimeType: 'image/jpeg', data: JPG.toString('base64') })
  })

  test('mime comes from the bytes, not the header: png sent as image/jpeg is image/png', async () => {
    const { id, p } = start()
    expect((await post(id, PNG, 'image/jpeg')).status).toBe(204)
    expect((await p).ok && (await p as { mimeType: string }).mimeType).toBe('image/png')
  })

  test('bad magic and non-png/jpeg images are 415 and leave the request open', async () => {
    const { id, p } = start()
    expect((await post(id, '<svg onload=alert(1)>', 'image/png')).status).toBe(415)
    expect((await post(id, GIF, 'image/gif')).status).toBe(415)
    expect((await post(id, JPG)).status).toBe(204)
    expect((await p).ok).toBe(true)
  })

  test('oversize body is 413', async () => {
    const { id, p } = start()
    expect((await post(id, Buffer.concat([JPG, Buffer.alloc(MAX_SHOT_BYTES)]))).status).toBe(413)
    broker.answer(id, { ok: false, code: 'test_cleanup' })
    await p
  })

  test('unknown and malformed ids are 404', async () => {
    expect((await post('00000000-0000-4000-8000-000000000000', JPG)).status).toBe(404)
    expect((await post('..%2F..%2Fetc', JPG)).status).toBe(404)
  })

  test('a second answer is 409', async () => {
    const { id, p } = start()
    expect((await post(id, JPG)).status).toBe(204)
    expect((await post(id, JPG)).status).toBe(409)
    await p
  })

  test('a JSON error report resolves the request with its code; junk codes become capture_failed', async () => {
    const a = start()
    expect((await post(a.id, JSON.stringify({ error: 'hidden_tab' }), 'application/json')).status).toBe(204)
    expect(await a.p).toEqual({ ok: false, code: 'hidden_tab' })
    const b = start()
    expect((await post(b.id, JSON.stringify({ error: 'Bad Code <x>' }), 'application/json')).status).toBe(204)
    expect(await b.p).toEqual({ ok: false, code: 'capture_failed' })
  })

  test('GET is 405', async () => {
    expect((await fetch(`${base}${CANVAS_SHOT_PREFIX}x`)).status).toBe(405)
  })
})

describe('canvas-shot through the real route table', () => {
  const id = '00000000-0000-4000-8000-000000000000'
  test('a caller without the webterm page (plain curl, agent shell) is 403', async () => {
    expect((await post(id, JPG, 'image/jpeg', apiBase)).status).toBe(403)
  })
  test('forged same-origin metadata without the wt_ui cookie is 403', async () => {
    expect((await post(id, JPG, 'image/jpeg', apiBase, { 'sec-fetch-site': 'same-origin', origin: apiBase })).status).toBe(403)
  })
  test('the signed-in page reaches the handler (unknown id -> 404, not 403)', async () => {
    expect((await post(id, JPG, 'image/jpeg', apiBase, { 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE })).status).toBe(404)
  })
})
