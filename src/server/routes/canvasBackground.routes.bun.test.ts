// Canvas wallpaper routes over a REAL http server + temp dir: magic-byte validation, size cap,
// traversal, content-type, replace/delete removing the old file, and the root-token gate.
import { afterAll, test, expect } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { promises as fs, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeSettings, type Settings } from '../../shared/settings'
import { nextSettings } from '../settingsStore'
import { authorizeRequest } from '../auth'
import { MAX_CANVAS_IMAGE_BYTES } from '../canvasBackground.store'
import { CANVAS_IMAGE_PATH, canvasBackgroundRoute } from './canvasBackground.routes'

const dir = mkdtempSync(join(tmpdir(), 'wt-canvasbg-'))
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
afterAll(async () => {
  server.close()
  await fs.rm(dir, { recursive: true, force: true })
})

// test-only: smallest headers that pass the magic-byte sniff.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8)])

const upload = (bytes: Buffer, q = ''): Promise<Response> => fetch(base + q, { method: 'POST', body: new Uint8Array(bytes) })
const files = async (): Promise<string[]> => (await fs.readdir(dir).catch(() => [] as string[])).sort()

test('rejects non-image bytes by magic, even when they claim to be an image', async () => {
  const res = await fetch(base, { method: 'POST', body: '<svg onload=alert(1)>', headers: { 'Content-Type': 'image/png' } })
  expect(res.status).toBe(415)
  expect(await files()).toEqual([])
})

test('rejects bodies over the 10 MB cap with 413 and stores nothing', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_CANVAS_IMAGE_BYTES)])
  const res = await upload(big)
  expect(res.status).toBe(413)
  expect(await files()).toEqual([])
})

test('accepts png/jpeg/webp/gif and serves each with its content type', async () => {
  const cases: [Buffer, string][] = [[PNG, 'image/png'], [JPG, 'image/jpeg'], [WEBP, 'image/webp'], [GIF, 'image/gif']]
  for (const [bytes, type] of cases) {
    const res = await upload(bytes)
    expect(res.status).toBe(200)
    const s = (await res.json()) as Settings
    expect(s.canvasBackground.mode).toBe('image')
    const got = await fetch(`${base}/${s.canvasBackground.imageId}`)
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe(type)
    expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true)
  }
})

test('replacing the global image deletes the old file; only the current one remains', async () => {
  const id = store.getSettings().canvasBackground.imageId
  expect(await files()).toEqual([id])
  const res = await upload(PNG)
  const next = ((await res.json()) as Settings).canvasBackground.imageId
  expect(next === id).toBe(false)
  expect(await files()).toEqual([next])
})

test('workspace override gets its own image; global file kept while still referenced', async () => {
  const globalId = store.getSettings().canvasBackground.imageId
  const res = await upload(JPG, '?workspace=ws-1')
  const s = (await res.json()) as Settings
  const wsId = s.canvasBackgroundByWorkspace['ws-1']?.imageId ?? ''
  expect(s.canvasBackground.imageId).toBe(globalId)
  expect(wsId.endsWith('.jpg')).toBe(true)
  expect(await files()).toEqual([globalId, wsId].sort())
  const del = await fetch(`${base}?workspace=ws-1`, { method: 'DELETE' })
  const after = (await del.json()) as Settings
  expect(after.canvasBackgroundByWorkspace['ws-1']?.imageId).toBe('')
  expect(after.canvasBackgroundByWorkspace['ws-1']?.mode).toBe('default')
  expect(await files()).toEqual([globalId])
})

test('serve refuses traversal and unknown ids; missing file is 404', async () => {
  await fs.writeFile(join(dir, '..', 'wt-canvasbg-secret.txt'), 'secret').catch(() => undefined)
  for (const bad of ['..%2Fwt-canvasbg-secret.txt', '../wt-canvasbg-secret.txt', 'x.png', '00000000-0000-0000-0000-000000000000.svg']) {
    const res = await fetch(`${base}/${bad}`)
    expect(`${bad}:${res.status}`).toBe(`${bad}:404`)
  }
  const missing = await fetch(`${base}/00000000-0000-0000-0000-000000000000.png`)
  expect(missing.status).toBe(404)
  await fs.rm(join(dir, '..', 'wt-canvasbg-secret.txt'), { force: true })
})

test('requires the root token like every /api path (no node-token bypass)', () => {
  const headers = { host: '127.0.0.1:8700' }
  const args = { headers, expectedToken: 'tok', pathname: '/api/canvas-background/image', isNodeToken: () => true }
  expect(authorizeRequest(args)).toBe(false)
  expect(authorizeRequest({ ...args, queryToken: 'wrong' })).toBe(false)
  expect(authorizeRequest({ ...args, queryToken: 'tok' })).toBe(true)
})
