// ops-212-1: a manifest entry whose file is missing must answer 404 for that request and leave
// the server serving — it used to reject unhandled and kill the whole process.
import { test, expect } from 'bun:test'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { resolveAsset, serveAsset } from './staticAssets'

test('a missing asset file answers 404 and the server keeps serving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-static-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html>ok')
  // test-only manifest: one live file, one entry pointing at a file that is gone.
  const assets = { '/index.html': join(dir, 'index.html'), '/assets/gone.js': join(dir, 'gone.js') }
  const rejections: unknown[] = []
  const onRejection = (r: unknown) => void rejections.push(r)
  process.on('unhandledRejection', onRejection)
  const server = http.createServer((req, res) => {
    const hit = resolveAsset(new URL(req.url ?? '/', 'http://x').pathname, assets)
    if (!hit) { res.statusCode = 404; res.end(); return }
    void serveAsset(res, hit)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const gone = await fetch(`${base}/assets/gone.js`)
    expect(gone.status).toBe(404)
    const alive = await fetch(`${base}/index.html`)
    expect(alive.status).toBe(200)
    expect(alive.headers.get('content-type')).toBe('text/html')
    expect(await alive.text()).toBe('<!doctype html>ok')
    expect(rejections.length).toBe(0)
  } finally {
    process.off('unhandledRejection', onRejection)
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
