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

test('direktori dengan index.html sendiri (PWA /m) dilayani sebelum fallback SPA', () => {
  const withM = { ...manifest, '/m/index.html': '/embed/m/index.html', '/m/sw.js': '/embed/m/sw.js' }
  for (const p of ['/m', '/m/']) expect(resolveAsset(p, withM)).toEqual({ assetPath: '/embed/m/index.html', contentType: 'text/html', cacheControl: 'no-cache' })
  expect(resolveAsset('/m/sw.js', withM)?.assetPath).toBe('/embed/m/sw.js')
  expect(resolveAsset('/m/missing.js', withM)?.assetPath).toBe('/embed/index.html') // has an extension: no index guess
  expect(resolveAsset('/', withM)?.assetPath).toBe('/embed/index.html')
  expect(resolveAsset('/workspace/foo', withM)?.assetPath).toBe('/embed/index.html')
})
