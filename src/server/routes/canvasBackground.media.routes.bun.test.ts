// Wallpaper video over a REAL http server + temp dir: streaming upload (caps, partial cleanup, atomic
// rename, sniff beats the claimed type), HTTP Range (WebKit refuses video without it), HEAD, headers.
import { afterAll, expect, test } from 'bun:test'
import http, { createServer, type Server } from 'node:http'
import { promises as fs, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeSettings, type Settings } from '../../shared/settings'
import { MAX_CANVAS_IMAGE_BYTES, MAX_CANVAS_VIDEO_BYTES } from '../../shared/canvasBackground.schema'
import { nextSettings } from '../settingsStore'
import { CANVAS_IMAGE_PATH, canvasBackgroundRoute } from './canvasBackground.routes'

const dir = mkdtempSync(join(tmpdir(), 'wt-canvasbg-media-'))
let stored: string | null = null
const store = {
  getSettings: (): Settings => mergeSettings(stored ? JSON.parse(stored) : null),
  saveSettings: (patch: unknown): Settings => { const next = nextSettings(stored, patch); stored = JSON.stringify(next); return next },
}
const server: Server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x')
  void canvasBackgroundRoute({ req, res, url, path: url.pathname, method: req.method || 'GET' }, { store, dir }).then((hit) => {
    if (!hit) { res.statusCode = 404; res.end() }
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}${CANVAS_IMAGE_PATH}`
afterAll(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }) })

const MIB = 1024 * 1024
// test-only: a byte pattern where every offset is identifiable, behind a valid mp4 / webm header.
const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(12)])
const WEBM_HEAD = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm', 'latin1'), Buffer.alloc(20)])
const body = (head: Buffer, size = 1000): Buffer => Buffer.concat([head, Buffer.from(Array.from({ length: size - head.length }, (_, i) => i % 251))])
const files = async (): Promise<string[]> => (await fs.readdir(dir).catch(() => [] as string[])).sort()

/** POST `total` bytes in 1 MiB chunks after `head` (no Content-Length: the case a header check misses). */
function postChunked(head: Buffer, total: number, query = ''): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `${CANVAS_IMAGE_PATH}${query}`, method: 'POST' }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0 })) })
    req.on('error', (err) => (String(err).includes('EPIPE') || String(err).includes('ECONNRESET') ? undefined : reject(err)))
    req.write(head)
    let sent = head.length
    const chunk = Buffer.alloc(MIB)
    const pump = (): void => {
      while (sent < total) {
        const n = Math.min(MIB, total - sent)
        sent += n
        if (!req.write(n === MIB ? chunk : chunk.subarray(0, n))) { req.once('drain', pump); return }
      }
      req.end()
    }
    pump()
  })
}

const postBytes = (bytes: Buffer, q = ''): Promise<Response> => fetch(base + q, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': 'image/png' } })

test('mp4 upload is streamed to disk, stored as <uuid>.mp4, marked animated, mode 0600, no .part left', async () => {
  const bytes = body(MP4_HEAD)
  const res = await postBytes(bytes, '?name=evil.png')
  expect(res.status).toBe(200)
  const bg = ((await res.json()) as Settings).canvasBackground
  expect(bg.imageId).toMatch(/^[0-9a-f-]{36}\.mp4$/) // the claimed png type and name never reach the file name
  expect([bg.mode, bg.imageAnimated]).toEqual(['image', true])
  expect(await files()).toEqual([bg.imageId])
  expect(statSync(join(dir, bg.imageId)).mode & 0o777).toBe(0o600)
  const got = await fetch(`${base}/${bg.imageId}`)
  expect(got.headers.get('content-type')).toBe('video/mp4')
  expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true)
})

test('webm upload is accepted and a replacement removes the previous video', async () => {
  const before = store.getSettings().canvasBackground.imageId
  const res = await postBytes(body(WEBM_HEAD))
  const id = ((await res.json()) as Settings).canvasBackground.imageId
  expect(id.endsWith('.webm')).toBe(true)
  expect(await files()).toEqual([id])
  expect(before).not.toBe(id)
})

test('unknown type -> 415 and nothing stored (also when the body is shorter than the sniff window)', async () => {
  for (const bad of [Buffer.from('<svg onload=alert(1)>'), body(Buffer.from('not media at all, long enough to fill the sniff window....................'), 500), Buffer.alloc(0)]) {
    const res = await postBytes(bad)
    expect(res.status).toBe(415)
  }
  expect((await files()).filter((f) => !f.endsWith('.webm'))).toEqual([]) // only the earlier webm remains
})

test('video over the cap -> 413, partial file removed; the previous wallpaper stays', async () => {
  const keep = store.getSettings().canvasBackground.imageId
  const { status } = await postChunked(MP4_HEAD, MAX_CANVAS_VIDEO_BYTES + MIB)
  expect(status).toBe(413)
  expect(await files()).toEqual([keep])
  expect(store.getSettings().canvasBackground.imageId).toBe(keep)
})

test('a declared Content-Length over the video cap is refused before any byte is stored', async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: CANVAS_IMAGE_PATH, method: 'POST', headers: { 'content-length': String(MAX_CANVAS_VIDEO_BYTES + 1) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); req.destroy() })
    req.on('error', (err) => (String(err).includes('ECONNRESET') ? undefined : reject(err)))
    req.write(MP4_HEAD)
  })
  expect(status).toBe(413)
  expect((await files()).some((f) => f.endsWith('.part'))).toBe(false)
})

test('an image is capped at the image limit even though video may be larger', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])
  const { status } = await postChunked(png, MAX_CANVAS_IMAGE_BYTES + MIB)
  expect(status).toBe(413)
  expect((await files()).some((f) => f.endsWith('.part') || f.endsWith('.png'))).toBe(false)
})

test('Range: first/middle/last window, open-ended, suffix, HEAD and headers', async () => {
  const bytes = body(MP4_HEAD)
  const id = ((await (await postBytes(bytes)).json()) as Settings).canvasBackground.imageId
  const get = (range?: string, method = 'GET'): Promise<Response> => fetch(`${base}/${id}`, { method, headers: range ? { Range: range } : {} })
  const check = async (range: string, start: number, end: number): Promise<void> => {
    const r = await get(range)
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe(`bytes ${start}-${end}/${bytes.length}`)
    expect(r.headers.get('content-length')).toBe(String(end - start + 1))
    expect(Buffer.from(await r.arrayBuffer()).equals(bytes.subarray(start, end + 1))).toBe(true)
  }
  await check('bytes=0-99', 0, 99)
  await check('bytes=400-499', 400, 499)
  await check('bytes=900-999', 900, 999)
  await check('bytes=900-', 900, 999)
  await check('bytes=-100', 900, 999)
  await check('bytes=990-5000', 990, 999) // end past EOF is clamped
  const whole = await get()
  expect(whole.status).toBe(200)
  expect(whole.headers.get('accept-ranges')).toBe('bytes')
  expect(whole.headers.get('x-content-type-options')).toBe('nosniff')
  expect(whole.headers.get('cache-control')?.startsWith('private')).toBe(true)
  const head = await get(undefined, 'HEAD')
  expect([head.status, head.headers.get('content-length'), head.headers.get('content-type')]).toEqual([200, '1000', 'video/mp4'])
  expect((await head.arrayBuffer()).byteLength).toBe(0)
  const headRange = await get('bytes=0-9', 'HEAD')
  expect([headRange.status, headRange.headers.get('content-range')]).toEqual([206, 'bytes 0-9/1000'])
})

test('Range: unsatisfiable -> 416 with Content-Range */size; multi-range or junk is served whole', async () => {
  const id = store.getSettings().canvasBackground.imageId
  for (const bad of ['bytes=1000-', 'bytes=2000-3000', 'bytes=5-2', 'bytes=-0', 'bytes=-']) {
    const r = await fetch(`${base}/${id}`, { headers: { Range: bad } })
    expect(`${bad}:${r.status}:${r.headers.get('content-range')}`).toBe(`${bad}:416:bytes */1000`)
  }
  for (const odd of ['bytes=0-1,5-9', 'items=0-1', 'garbage']) {
    expect((await fetch(`${base}/${id}`, { headers: { Range: odd } })).status).toBe(200)
  }
})

test('writes other than GET/HEAD/POST/DELETE on a file are 405; unknown mp4 id is 404', async () => {
  const id = store.getSettings().canvasBackground.imageId
  expect((await fetch(`${base}/${id}`, { method: 'PUT' })).status).toBe(405)
  expect((await fetch(`${base}/00000000-0000-0000-0000-000000000000.mp4`)).status).toBe(404)
  expect((await fetch(`${base}/${id}`, { headers: { Range: 'bytes=0-1' }, method: 'DELETE' })).status).toBe(405)
})

test('removing the video clears the animated flag and deletes the file', async () => {
  const res = await fetch(base, { method: 'DELETE' })
  const bg = ((await res.json()) as Settings).canvasBackground
  expect([bg.imageId, bg.imageAnimated, bg.mode]).toEqual(['', false, 'default'])
  expect(await files()).toEqual([])
})
