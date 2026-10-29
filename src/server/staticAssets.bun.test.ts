// resolveAsset: hit langsung, fallback SPA, content-type per ekstensi, manifest kosong → null.
import { test, expect } from 'bun:test'
import { resolveAsset } from './staticAssets'

const manifest = {
  '/index.html': '/embed/index.html',
  '/assets/app.js': '/embed/assets/app.js',
  '/favicon.ico': '/embed/favicon.ico',
}

test('hit langsung mengembalikan aset + content-type dari ekstensi', () => {
  const hit = resolveAsset('/assets/app.js', manifest)
  expect(hit?.assetPath).toBe('/embed/assets/app.js')
  expect(hit?.contentType).toBe('text/javascript')
})

test('path tak dikenal fallback SPA ke /index.html sebagai text/html', () => {
  const hit = resolveAsset('/workspace/foo', manifest)
  expect(hit?.assetPath).toBe('/embed/index.html')
  expect(hit?.contentType).toBe('text/html')
})

test('ekstensi tak dikenal → application/octet-stream', () => {
  const hit = resolveAsset('/favicon.ico', manifest)
  expect(hit?.contentType).toBe('image/x-icon')
  // .ico ada di tabel; cek ekstensi di luar tabel lewat kunci manifest khusus
  const odd = resolveAsset('/data.bin', { ...manifest, '/data.bin': '/embed/data.bin' })
  expect(odd?.contentType).toBe('application/octet-stream')
})

test('manifest kosong → null', () => {
  expect(resolveAsset('/index.html', {})).toBe(null)
  expect(resolveAsset('/anything', {})).toBe(null)
})
