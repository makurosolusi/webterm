// The client router's deep links (src/client/appRoute.ts) in prod: every board/overlay URL must resolve to
// index.html so a reload or a pasted link boots the SPA, while the real files and the /m PWA keep their
// own entries. /api is not reached here at all in the server: `routeApp` (index.ts) answers it first.
import { test, expect } from 'bun:test'
import { resolveAsset } from './staticAssets'

const manifest = { // test-only
  '/index.html': '/embed/index.html',
  '/assets/app-abc.js': '/embed/assets/app-abc.js',
  '/m/index.html': '/embed/m/index.html',
  '/m/sw.js': '/embed/m/sw.js',
}
const resolve = (href: string) => resolveAsset(new URL(href, 'http://x').pathname, manifest)

test('client deep links resolve to index.html', () => {
  for (const href of ['/w/3f2c9a1e-7b4d-4c1a-9e2f-0a1b2c3d4e5f', '/w/x?settings=canvas', '/w/x?ctab=memory&panel=problems', '/settings/x', '/']) {
    expect(resolve(href)).toEqual({ assetPath: '/embed/index.html', contentType: 'text/html', cacheControl: 'no-cache' })
  }
})

test('deep links do not shadow real files or the /m PWA', () => {
  expect(resolve('/assets/app-abc.js')?.assetPath).toBe('/embed/assets/app-abc.js')
  expect(resolve('/m/')?.assetPath).toBe('/embed/m/index.html')
  expect(resolve('/m')?.assetPath).toBe('/embed/m/index.html')
  expect(resolve('/m/sw.js')?.assetPath).toBe('/embed/m/sw.js')
})

// Known quirks, pinned so a fix shows up as a deliberate test change (not fixed here):
test('known quirk: an unknown /api path falls through to index.html (200, not a JSON 404)', () => {
  expect(resolve('/api/foo')?.assetPath).toBe('/embed/index.html')
})

test('known quirk: an unknown path under /m gets the desktop index, not the /m PWA', () => {
  expect(resolve('/m/anything')?.assetPath).toBe('/embed/index.html')
})
