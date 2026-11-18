import { describe, expect, it } from 'vitest'
import type { BrowserTab } from '../../shared/browser.tabs'
import { MAX_FAVICON_BYTES } from '../../shared/browser.favicon'
import type { IconLink } from '../../shared/browser.favicon'
import { CDP } from './cdp.client'
import { createFavicons, FAVICON_DEBOUNCE_MS, FAVICON_RATE_MAX, FAVICON_RATE_WINDOW_MS } from './browserHost.favicon'
import { FAVICON_BINDING } from './browser.favicon.script'
import { stubGuard } from './fakeCdp.testkit'
import type { NodeRec } from './browserHost.targets'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9])
const uri = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`

/** One page per tab: links it declares, icon bytes by url; records every CDP call and every tab patch. */
function rig(opts: { blocked?: string[] } = {}) {
  let t = 0
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let ids = 0
  const tabs = new Map<string, BrowserTab>()
  const links = new Map<string, IconLink[]>()
  const files = new Map<string, Buffer | number>() // url -> bytes, or an http status
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const patches: Array<{ tabId: string; patch: Partial<BrowserTab> }> = []
  const rec = { nodeId: 'n1', profileId: 'p1' } as NodeRec
  const broken = new Set<string>() // tabs whose Runtime.evaluate fails
  const streams = new Map<string, Buffer>()
  let handle = 0
  const f = createFavicons({
    guard: stubGuard(opts.blocked ?? []), now: () => t,
    tab: (_r, id) => tabs.get(id), sessionOf: (_r, id) => (tabs.has(id) ? `S-${id}` : undefined),
    patch: (_r, id, patch) => { patches.push({ tabId: id, patch }); tabs.set(id, { ...(tabs.get(id) as BrowserTab), ...patch }) },
    setTimer: (fn, ms) => { const id = ++ids; timers.push({ at: t + ms, fn, id }); return id },
    clearTimer: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1) },
    send: async (_r, sid, method, params = {}) => {
      calls.push({ method, params: params as Record<string, unknown> })
      const tabId = sid.slice(2)
      if (method === CDP.evaluate && broken.has(tabId)) throw new Error('Cannot find context with specified id')
      if (method === CDP.evaluate) return { result: { value: JSON.stringify(links.get(tabId) ?? []) } }
      if (method === CDP.getFrameTree) return { frameTree: { frame: { id: `F-${tabId}` } } }
      if (method === CDP.loadNetworkResource) {
        const hit = files.get(String((params as { url: string }).url))
        if (hit === undefined) return { resource: { success: false, netError: -105 } }
        if (typeof hit === 'number') return { resource: { success: true, httpStatusCode: hit, stream: 'h-err' } }
        const h = `h${++handle}`
        streams.set(h, hit)
        return { resource: { success: true, httpStatusCode: 200, stream: h } }
      }
      if (method === CDP.ioRead) { const b = streams.get(String((params as { handle: string }).handle)); return { data: (b ?? Buffer.alloc(0)).toString('base64'), base64Encoded: true, eof: true } }
      return {}
    },
  })
  const add = (id: string, url: string, l: IconLink[] = []) => { tabs.set(id, { tabId: id, title: '', url, loading: false, discarded: false, crashed: false }); links.set(id, l) }
  const advance = async (ms: number) => {
    t += ms
    for (const x of timers.filter((y) => y.at <= t).sort((a, b) => a.at - b.at)) { timers.splice(timers.indexOf(x), 1); x.fn() }
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  }
  const settle = () => advance(FAVICON_DEBOUNCE_MS)
  const fetches = () => calls.filter((c) => c.method === CDP.loadNetworkResource)
  return { f, rec, add, broken, tabs, links, files, calls, patches, settle, advance, fetches, setNow: (n: number) => { t = n } }
}

const icon = (href: string): IconLink => ({ rel: 'icon', href })

describe('favicon tracker', () => {
  it('reads the declared icon after the quiet period and stores it as a data URI (url on the tab, bytes runtime-only)', async () => {
    const r = rig()
    r.add('a', 'https://app.test/', [icon('https://app.test/i.png')])
    r.files.set('https://app.test/i.png', PNG)
    r.f.loaded(r.rec, 'a')
    expect(r.calls).toHaveLength(0)
    await r.settle()
    expect(r.tabs.get('a')).toMatchObject({ favicon: 'https://app.test/i.png', faviconData: uri(PNG) })
    const fetch = r.fetches()[0].params
    expect(fetch).toMatchObject({ frameId: 'F-a', url: 'https://app.test/i.png', options: { disableCache: false, includeCredentials: true } })
    expect(r.calls.some((c) => c.method === CDP.addBinding && c.params.name === FAVICON_BINDING)).toBe(true)
  })

  it('falls back to /favicon.ico when the page declares nothing', async () => {
    const r = rig()
    r.add('a', 'http://localhost:3000/x')
    r.files.set('http://localhost:3000/favicon.ico', Buffer.from([0, 0, 1, 0, 1, 0, 0, 0]))
    r.f.loaded(r.rec, 'a')
    await r.settle()
    expect(r.tabs.get('a')?.favicon).toBe('http://localhost:3000/favicon.ico')
    expect(r.tabs.get('a')?.faviconData).toMatch(/^data:image\/x-icon;base64,/)
  })

  it('coalesces a burst of triggers into one read', async () => {
    const r = rig()
    r.add('a', 'https://app.test/', [icon('https://app.test/i.png')])
    r.files.set('https://app.test/i.png', PNG)
    for (let i = 0; i < 5; i++) { r.f.binding(r.rec, 'a', { name: FAVICON_BINDING }); await r.advance(100) }
    await r.settle()
    expect(r.calls.filter((c) => c.method === CDP.evaluate)).toHaveLength(1)
  })

  it('ignores bindings that are not its own', async () => {
    const r = rig()
    r.add('a', 'https://app.test/')
    r.f.binding(r.rec, 'a', { name: 'somethingElse' })
    await r.settle()
    expect(r.calls).toHaveLength(0)
  })

  it('follows a <link> change: a new href is fetched and replaces the icon', async () => {
    const r = rig()
    r.add('a', 'https://app.test/', [icon('https://app.test/one.png')])
    r.files.set('https://app.test/one.png', PNG)
    r.files.set('https://app.test/two.png', PNG2)
    r.f.loaded(r.rec, 'a')
    await r.settle()
    r.links.set('a', [icon('https://app.test/two.png')])
    r.f.binding(r.rec, 'a', { name: FAVICON_BINDING })
    await r.settle()
    expect(r.tabs.get('a')?.faviconData).toBe(uri(PNG2))
  })

  it('caps reads per tab: a page swapping its icon every second is read at most FAVICON_RATE_MAX times per window, then once the window rolls', async () => {
    const r = rig()
    r.add('a', 'https://app.test/', [icon('https://app.test/i.png')])
    r.files.set('https://app.test/i.png', PNG)
    for (let i = 0; i < FAVICON_RATE_MAX + 4; i++) { r.f.binding(r.rec, 'a', { name: FAVICON_BINDING }); await r.advance(FAVICON_DEBOUNCE_MS + 1) }
    const reads = () => r.calls.filter((c) => c.method === CDP.evaluate).length
    expect(reads()).toBe(FAVICON_RATE_MAX)
    await r.advance(FAVICON_RATE_WINDOW_MS)
    expect(reads()).toBe(FAVICON_RATE_MAX + 1) // the deferred read ran once the oldest left the window
  })

  it('shares the cache across tabs of one profile (one network fetch) but a reload of the same url forces a fresh one', async () => {
    const r = rig()
    r.add('a', 'https://app.test/p1', [icon('https://app.test/i.png')])
    r.add('b', 'https://app.test/p2', [icon('https://app.test/i.png')])
    r.files.set('https://app.test/i.png', PNG)
    r.f.loaded(r.rec, 'a'); await r.settle()
    r.f.loaded(r.rec, 'b'); await r.settle()
    expect(r.fetches()).toHaveLength(1)
    expect(r.tabs.get('b')?.faviconData).toBe(uri(PNG))
    // The developer changes the icon and reloads tab a (same url): it must not be served from memory.
    r.files.set('https://app.test/i.png', PNG2)
    r.f.loaded(r.rec, 'a'); await r.settle()
    expect(r.fetches()).toHaveLength(2)
    expect(r.fetches()[1].params).toMatchObject({ options: { disableCache: true } })
    expect(r.tabs.get('a')?.faviconData).toBe(uri(PNG2))
    expect(r.tabs.get('b')?.faviconData).toBe(uri(PNG)) // b picks the new one on its next load
  })

  it('refuses a cross-origin icon that points a public page at loopback: no request is made', async () => {
    const r = rig()
    r.add('a', 'https://evil.test/', [icon('http://127.0.0.1:8700/api/secret')])
    r.files.set('http://127.0.0.1:8700/api/secret', PNG)
    r.f.loaded(r.rec, 'a'); await r.settle()
    expect(r.fetches()).toHaveLength(0)
    expect(r.tabs.get('a')?.faviconData ?? '').toBe('')
  })

  it('allows the same-origin icon of a localhost dev server', async () => {
    const r = rig({ blocked: ['localhost'] }) // even when the guard blocks localhost for navigation, a page that is already there may load its own icon
    r.add('a', 'http://localhost:5173/', [icon('http://localhost:5173/fav.png')])
    r.files.set('http://localhost:5173/fav.png', PNG)
    r.f.loaded(r.rec, 'a'); await r.settle()
    expect(r.tabs.get('a')?.faviconData).toBe(uri(PNG))
  })

  it('decodes an inline data: icon without any network request', async () => {
    const r = rig()
    r.add('a', 'https://app.test/', [icon('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 1 1%22/%3E')])
    r.f.loaded(r.rec, 'a'); await r.settle()
    expect(r.fetches()).toHaveLength(0)
    expect(r.tabs.get('a')?.faviconData).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(r.tabs.get('a')?.favicon).toBe('') // an inline icon is not a url worth keeping on the board
  })

  it.each([
    ['a 404', 404],
    ['an HTML body', Buffer.from('<html>not found</html>')],
    ['an oversize body', Buffer.alloc(MAX_FAVICON_BYTES + 1, 1)],
    ['an unsafe SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')],
    ['no response', undefined],
  ])('clears the icon (globe) for %s and remembers the miss', async (_n, body) => {
    const r = rig()
    r.add('a', 'https://app.test/', [icon('https://app.test/i.png')])
    r.tabs.set('a', { ...(r.tabs.get('a') as BrowserTab), faviconData: uri(PNG) })
    if (body !== undefined) r.files.set('https://app.test/i.png', body)
    r.f.loaded(r.rec, 'a'); await r.settle()
    expect(r.tabs.get('a')?.faviconData).toBe('')
  })

  it('a CDP failure is logged, leaves the previous icon alone and does not throw', async () => {
    const r = rig()
    r.add('a', 'https://app.test/', [icon('https://app.test/i.png')])
    r.tabs.set('a', { ...(r.tabs.get('a') as BrowserTab), faviconData: uri(PNG) })
    r.broken.add('a')
    r.files.set('https://app.test/i.png', PNG)
    r.f.loaded(r.rec, 'a')
    await r.settle()
    expect(r.tabs.get('a')?.faviconData).toBe(uri(PNG))
  })

  it('a tab without a live page (discarded) is skipped; closing a tab drops its pending read', async () => {
    const r = rig()
    r.add('a', 'https://app.test/', [icon('https://app.test/i.png')])
    r.f.loaded(r.rec, 'a')
    r.f.dropTab(r.rec, 'a')
    await r.settle()
    expect(r.calls).toHaveLength(0)
    r.f.request(r.rec, 'ghost')
    await r.settle()
    expect(r.calls).toHaveLength(0)
  })

  it('a newer read wins over an older one still in flight', async () => {
    const r = rig()
    r.add('a', 'https://app.test/', [icon('https://app.test/one.png')])
    r.files.set('https://app.test/one.png', PNG)
    r.files.set('https://app.test/two.png', PNG2)
    r.f.loaded(r.rec, 'a')
    r.advance(FAVICON_DEBOUNCE_MS) // read 1 starts (not awaited)
    r.links.set('a', [icon('https://app.test/two.png')])
    r.f.binding(r.rec, 'a', { name: FAVICON_BINDING })
    await r.advance(FAVICON_DEBOUNCE_MS)
    expect(r.tabs.get('a')?.faviconData).toBe(uri(PNG2))
  })
})
