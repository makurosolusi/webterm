// sec-208-4 lock. (1) Regression: the shared route body reader (`ctx.readBody`, git-info) stops at
// its cap and answers 413 instead of buffering the whole body (a 200 MB POST used to cost 500 MB RSS).
// (2) Policy: no server source reads a request stream by hand outside the capped readers.
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { afterAll, describe, expect, test } from 'bun:test'
import http from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

process.env.WEBTERM_DATA_DIR = mkdtempSync(join(tmpdir(), 'wt-body-')) // before ../api -> ../db opens
const { handleApi } = await import('../api')
const { ROUTE_BODY_MAX_BYTES } = await import('./route.core')
const { GIT_INFO_PATH } = await import('../../shared/gitInfo')

const SERVER = join(import.meta.dirname, '..')
const TEST_FILE = /\.(test|testutil)\.ts$/
const REQUEST_READ = /\breq(uest)?\.on\(\s*['"]data['"]/
/** The capped readers, plus offline eval harnesses whose own throwaway server is not webterm's listener. */
const CAPPED_READERS = new Set([
  'channels/channelHttp.ts', // readCappedBody: cap enforced while streaming
  'approvalHttp.ts', // overflow flag -> 413
  'canvasBackground.store.ts', // readBinaryBody: cap enforced while streaming
  'evalcases/evalReplay.ts', // offline eval harness, in-process test server only
  'central/eval/goldenHarness.ts', // offline eval harness, in-process test server only
])
const UI = { 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE, 'content-type': 'application/json' }

const server = http.createServer((req, res) => { if (!handleApi(req, res)) { res.statusCode = 404; res.end() } })
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
afterAll(() => { server.close() })

/** POST `chunks` one write each; no Content-Length when `chunked` (the case a header check misses). */
function post(path: string, chunks: string[], chunked: boolean): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const total = chunks.reduce((n, c) => n + Buffer.byteLength(c), 0)
    const headers = chunked ? UI : { ...UI, 'content-length': String(total) }
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    // The server may answer 413 and stop reading mid-upload; the response still arrives.
    req.on('error', (err) => (String(err).includes('EPIPE') || String(err).includes('ECONNRESET') ? undefined : reject(err)))
    for (const c of chunks) req.write(c)
    req.end()
  })
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return p.endsWith('.ts') && !TEST_FILE.test(p) ? [p] : []
  })
}

describe('route body cap (sec-208-4)', () => {
  test('git-info: a body of cap+1 bytes with Content-Length -> 413 with a message', async () => {
    const r = await post(GIT_INFO_PATH, ['x'.repeat(ROUTE_BODY_MAX_BYTES + 1)], false)
    expect(r.status).toBe(413)
    expect(JSON.parse(r.body).error).toBe('payload_too_large')
  })

  test('git-info: a chunked body past the cap (no Content-Length) -> 413', async () => {
    const chunk = 'y'.repeat(16 * 1024)
    const r = await post(GIT_INFO_PATH, Array.from({ length: Math.ceil(ROUTE_BODY_MAX_BYTES / chunk.length) + 2 }, () => chunk), true)
    expect(r.status).toBe(413)
  })

  test('git-info: a normal body still answers', async () => {
    const r = await post(GIT_INFO_PATH, [JSON.stringify({ paths: [tmpdir()] })], false)
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body).results).toHaveLength(1)
  })

  test('no server source reads a request stream outside the capped readers', () => {
    const offenders = sources(SERVER)
      .map((p) => relative(SERVER, p))
      .filter((rel) => !CAPPED_READERS.has(rel) && REQUEST_READ.test(readFileSync(join(SERVER, rel), 'utf8')))
    expect(offenders).toEqual([])
  })
})
