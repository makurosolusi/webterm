// Share URLs in index.html: the placeholder origin becomes the requesting origin at serve time,
// a hostile Host never reaches the HTML, and other files pass through untouched.
import { test, expect } from 'bun:test'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { resolveAsset, serveAsset } from './staticAssets'
import { ORIGIN_PLACEHOLDER, requestOrigin, withRequestOrigin } from './staticAssets.origin'

test('requestOrigin: Host + scheme, X-Forwarded-Proto https wins, unsafe Host is null', () => {
  expect(requestOrigin({ host: '127.0.0.1:8700' })).toBe('http://127.0.0.1:8700')
  expect(requestOrigin({ host: 'term.example.dev', 'x-forwarded-proto': 'https' })).toBe('https://term.example.dev')
  expect(requestOrigin({ host: '[::1]:8700' }, true)).toBe('https://[::1]:8700')
  expect(requestOrigin({ host: 'a.dev', 'x-forwarded-proto': 'http' }, true)).toBe('http://a.dev')
  expect(requestOrigin({})).toBeNull()
  expect(requestOrigin({ host: 'evil"><script>' })).toBeNull()
})

test('withRequestOrigin: every placeholder replaced; null leaves root-relative URLs', () => {
  const html = `<meta content="${ORIGIN_PLACEHOLDER}/og-image.png"><meta content="${ORIGIN_PLACEHOLDER}/og-image.png">`
  expect(withRequestOrigin(html, 'http://10.0.0.5:8700')).toBe('<meta content="http://10.0.0.5:8700/og-image.png"><meta content="http://10.0.0.5:8700/og-image.png">')
  expect(withRequestOrigin(html, null)).toBe('<meta content="/og-image.png"><meta content="/og-image.png">')
})

test('serveAsset rewrites the placeholder in HTML only, per request Host, without a token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-origin-'))
  const page = `<meta property="og:image" content="${ORIGIN_PLACEHOLDER}/og-image.png">`
  writeFileSync(join(dir, 'index.html'), page)
  writeFileSync(join(dir, 'note.json'), `"${ORIGIN_PLACEHOLDER}"`)
  const assets = { '/index.html': join(dir, 'index.html'), '/note.json': join(dir, 'note.json') } // test-only manifest
  const server = http.createServer((req, res) => {
    const hit = resolveAsset(new URL(req.url ?? '/', 'http://x').pathname, assets)
    if (!hit) { res.statusCode = 404; res.end(); return }
    void serveAsset(res, hit, undefined, requestOrigin(req.headers))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  try {
    const direct = await fetch(`http://127.0.0.1:${port}/`)
    expect(direct.status).toBe(200)
    expect(await direct.text()).toBe(`<meta property="og:image" content="http://127.0.0.1:${port}/og-image.png">`)
    const tunneled = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: 'term.example.dev', 'x-forwarded-proto': 'https' } })
    expect(await tunneled.text()).toContain('content="https://term.example.dev/og-image.png"')
    expect(await (await fetch(`http://127.0.0.1:${port}/note.json`)).text()).toBe(`"${ORIGIN_PLACEHOLDER}"`)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
