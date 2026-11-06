// The installable shell: manifest, icons and service worker in src/client/public/m, and the pure
// client helpers (push support).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { b64urlToBytes, pushSupport, type PushEnv } from './mobile.push'

const PUBLIC = join(process.cwd(), 'src/client/public/m')
const read = (f: string) => readFileSync(join(PUBLIC, f))

/** Width/height from a PNG IHDR chunk. */
const pngSize = (buf: Buffer) => ({ png: buf.subarray(1, 4).toString() === 'PNG', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) })

describe('manifest', () => {
  const m = JSON.parse(read('manifest.json').toString()) as Record<string, unknown> & { icons: Array<{ src: string; sizes: string; type: string; purpose?: string }> }

  it('is installable: standalone, scoped to /m/, with 192 and 512 PNG icons that exist at those sizes', () => {
    expect(m).toMatchObject({ name: 'webterm', short_name: 'webterm', start_url: '/m/', scope: '/m/', id: '/m/', display: 'standalone' })
    for (const size of ['192x192', '512x512']) {
      const icon = m.icons.find((i) => i.sizes === size && i.type === 'image/png' && i.purpose !== 'maskable')!
      expect(icon.src.startsWith('/m/')).toBe(true)
      const dim = pngSize(read(icon.src.slice(3)))
      expect(dim).toEqual({ png: true, w: Number(size.split('x')[0]), h: Number(size.split('x')[1]) })
    }
    for (const icon of m.icons) expect(() => read(icon.src.slice(3))).not.toThrow()
  })

  it('is linked from the /m page with the iOS home-screen tags', () => {
    const html = readFileSync(join(process.cwd(), 'src/client/m/index.html'), 'utf8')
    expect(html).toContain('<link rel="manifest" href="/m/manifest.json" />')
    expect(html).toContain('apple-mobile-web-app-capable')
    expect(html).toContain('viewport-fit=cover')
    expect(pngSize(read('apple-touch-icon.png'))).toEqual({ png: true, w: 180, h: 180 })
  })
})

type Listener = (event: Record<string, unknown>) => void

/** Runs sw.js against fake worker globals; returns its listeners and what it cached/showed. */
function loadWorker() {
  const listeners: Record<string, Listener> = {}
  const puts: string[] = []
  const shown: Array<{ title: string; options: Record<string, unknown> }> = []
  const cache = { put: vi.fn(async (req: string | Request) => { puts.push(typeof req === 'string' ? req : req.url) }), addAll: vi.fn(async () => {}) }
  const self = {
    location: { origin: 'https://box.example' },
    addEventListener: (type: string, fn: Listener) => { listeners[type] = fn },
    registration: { showNotification: vi.fn(async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }) }) },
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => []), openWindow: vi.fn() },
    skipWaiting: vi.fn(),
  }
  const caches = { open: vi.fn(async () => cache), match: vi.fn(async () => undefined), keys: vi.fn(async () => []), delete: vi.fn() }
  const fetchFn = vi.fn(async () => ({ ok: true, type: 'basic', clone() { return this } }))
  new Function('self', 'caches', 'fetch', read('sw.js').toString())(self, caches, fetchFn)
  const fetchEvent = async (url: string, init: { method?: string; mode?: string } = {}) => {
    let responded: Promise<unknown> | null = null
    listeners.fetch!({ request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'cors' }, respondWith: (p: Promise<unknown>) => { responded = p } })
    if (responded) await responded
    await new Promise((r) => setTimeout(r, 0))
    return responded !== null
  }
  return { listeners, puts, shown, fetchEvent, fetchFn }
}

describe('service worker', () => {
  it('never answers or caches API, websocket, POST or cross-origin requests', async () => {
    const w = loadWorker()
    for (const url of ['https://box.example/api/approvals/inbox', 'https://box.example/api/brief', 'https://box.example/api/push', 'https://box.example/ws', 'https://cdn.other/assets/x.js']) {
      expect(await w.fetchEvent(url)).toBe(false)
    }
    expect(await w.fetchEvent('https://box.example/assets/m-1.js', { method: 'POST' })).toBe(false)
    expect(await w.fetchEvent('https://box.example/', { mode: 'navigate' })).toBe(false) // desktop page: not ours
    expect(w.puts).toEqual([])
  })

  it('caches the /m shell under its bare key (never the ?token= URL) and hashed assets', async () => {
    const w = loadWorker()
    expect(await w.fetchEvent('https://box.example/m/?token=secret123#inbox', { mode: 'navigate' })).toBe(true)
    expect(await w.fetchEvent('https://box.example/assets/m-1.js')).toBe(true)
    expect(w.puts).toEqual(['/m/', 'https://box.example/assets/m-1.js'])
    expect(w.puts.join()).not.toContain('secret123')
  })

  it('shows a push with its title and keeps taps inside /m', async () => {
    const w = loadWorker()
    const push = (data: unknown) => {
      let p: Promise<unknown> = Promise.resolve()
      w.listeners.push!({ data: { json: () => data }, waitUntil: (x: Promise<unknown>) => { p = x } })
      return p
    }
    await push({ id: 'gate_1', kind: 'gate', title: 'Claude wants to run: Bash(ls)', url: '/m/#inbox' })
    await push({ id: 'x', title: 'Phish', url: 'https://evil.test/' })
    expect(w.shown[0]).toMatchObject({ title: 'Claude wants to run: Bash(ls)', options: { tag: 'gate_1', data: { url: '/m/#inbox' } } })
    expect(w.shown[1]!.options.data).toEqual({ url: '/m/' })
  })
})

describe('pushSupport', () => {
  const env = (over: Partial<PushEnv>): PushEnv => ({
    isSecureContext: true, userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140', maxTouchPoints: 5, standalone: false,
    hasPushManager: true, hasServiceWorker: true, hasNotification: true, ...over,
  })
  it('explains what is missing', () => {
    expect(pushSupport(env({}))).toBe('ok')
    expect(pushSupport(env({ isSecureContext: false }))).toBe('insecure')
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'
    expect(pushSupport(env({ userAgent: iphone, hasPushManager: false }))).toBe('ios-install')
    expect(pushSupport(env({ userAgent: iphone, standalone: true }))).toBe('ok')
    expect(pushSupport(env({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', maxTouchPoints: 5 }))).toBe('ios-install') // iPadOS
    expect(pushSupport(env({ hasPushManager: false }))).toBe('unsupported')
  })
  it('decodes the VAPID key', () => {
    expect([...b64urlToBytes('BAEC_w')]).toEqual([4, 1, 2, 255])
  })
})
