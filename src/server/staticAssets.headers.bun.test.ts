// ops-212-9: hashed assets are cached forever, index.html revalidates, and text assets go out as
// brotli or gzip when the client accepts it (identity otherwise); already-compressed types stay raw.
import { afterAll, expect, test } from 'bun:test'
import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { CACHE_IMMUTABLE, CACHE_REVALIDATE, pickEncoding, resolveAsset, serveAsset } from './staticAssets'

const JS = 'export const x = 1;\n'.repeat(500) // test-only, compressible
const dir = mkdtempSync(join(tmpdir(), 'wt-static-h-'))
let server: http.Server | undefined

// Started at load and awaited by get(): the repo's bun:test type shim has no beforeAll.
const ready: Promise<number> = (async () => {
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html>app')
  writeFileSync(join(dir, 'assets', 'main-abc123.js'), JS)
  writeFileSync(join(dir, 'assets', 'logo-abc123.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const assets = {
    '/index.html': join(dir, 'index.html'),
    '/assets/main-abc123.js': join(dir, 'assets', 'main-abc123.js'),
    '/assets/logo-abc123.png': join(dir, 'assets', 'logo-abc123.png'),
  }
  server = http.createServer((req, res) => {
    const hit = resolveAsset(new URL(req.url ?? '/', 'http://x').pathname, assets)
    if (!hit) { res.statusCode = 404; res.end(); return }
    void serveAsset(res, hit, req.headers['accept-encoding'])
  })
  const srv = server
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return (srv.address() as AddressInfo).port
})()
afterAll(() => { server?.close(); rmSync(dir, { recursive: true, force: true }) })

/** Raw GET (fetch would decode and hide Content-Encoding). */
async function get(path: string, acceptEncoding?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const port = await ready
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

test('hashed /assets/* are immutable; index.html and the SPA fallback revalidate', async () => {
  expect((await get('/assets/main-abc123.js')).headers['cache-control']).toBe(CACHE_IMMUTABLE)
  expect(CACHE_IMMUTABLE).toBe('public, max-age=31536000, immutable')
  expect((await get('/index.html')).headers['cache-control']).toBe(CACHE_REVALIDATE)
  expect((await get('/workspace/abc')).headers['cache-control']).toBe(CACHE_REVALIDATE)
  expect(CACHE_REVALIDATE).toBe('no-cache')
})

test('brotli when accepted, and it decodes to the original bytes', async () => {
  for (let i = 0; i < 2; i++) { // second request comes from the compressed cache
    const r = await get('/assets/main-abc123.js', 'gzip, deflate, br')
    expect(r.headers['content-encoding']).toBe('br')
    expect(r.headers.vary).toBe('Accept-Encoding')
    expect(r.body.length < JS.length).toBe(true)
    expect(zlib.brotliDecompressSync(r.body).toString()).toBe(JS)
  }
})

test('gzip when brotli is not accepted (or refused with q=0)', async () => {
  for (const ae of ['gzip', 'br;q=0, gzip;q=0.8']) {
    const r = await get('/assets/main-abc123.js', ae)
    expect(r.headers['content-encoding']).toBe('gzip')
    expect(zlib.gunzipSync(r.body).toString()).toBe(JS)
  }
  expect((await get('/index.html', 'gzip')).headers['content-encoding']).toBe('gzip')
})

test('identity without Accept-Encoding; png is never recompressed', async () => {
  const plain = await get('/assets/main-abc123.js')
  expect(plain.headers['content-encoding']).toBe(undefined)
  expect(plain.body.toString()).toBe(JS)
  const png = await get('/assets/logo-abc123.png', 'br, gzip')
  expect(png.headers['content-encoding']).toBe(undefined)
  expect(png.headers['content-type']).toBe('image/png')
})

test('pickEncoding parses q-values', () => {
  expect(pickEncoding(undefined)).toBeNull()
  expect(pickEncoding('identity')).toBeNull()
  expect(pickEncoding('gzip;q=0, br;q=0')).toBeNull()
  expect(pickEncoding('BR')).toBe('br')
  expect(pickEncoding('deflate, gzip;q=1.0')).toBe('gzip')
})
