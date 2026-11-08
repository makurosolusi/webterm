// Bun-only, Chrome NYATA: jalur peluncuran produksi (flags + proxy SSRF + createPageTarget) tidak membawa tanda
// otomasi yang membuat situs mencapnya bot. Skip bersih bila tak ada Chromium, atau mode headless (memang terdeteksi).
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CDP, CdpClient, ignoreClosed } from './cdp.client'
import { headlessReason } from './chromium.flags'
import { detectChromium, launchChromium } from './chromium.launch'
import type { Launched } from './chromium.launch'
import { createPageTarget, DEFAULT_VIEWPORT, setupConnection } from './browserHost.targets'
import { allowKey } from './ssrf.allowlist'
import { startSsrfProxy } from './ssrf.proxy'

const found = detectChromium(process.env)
const TEST_TIMEOUT_MS = 60_000
const FRAME_WAIT_MS = 5_000
const POLL_MS = 100
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const PAGE = `<body style="margin:0"><button id=b style="width:400px;height:300px" onclick="window.clicked=true">x</button>
<div id=d></div><script>let n=0;(function f(){d.textContent=n++;requestAnimationFrame(f)})()</script></body>`

const cleanup: Array<() => unknown> = []
afterAll(async () => { for (const c of cleanup.reverse()) await c() })

// Ambient bun:test (bun-test.d.ts) tak punya skipIf: test hanya didaftarkan bila Chrome headful tersedia.
const RUNNABLE = found !== null && headlessReason(process.env) === null

describe('Chrome nyata: tanpa tanda bot', () => {
  if (!RUNNABLE) return
  test('UA & header tanpa Headless, webdriver false, frame screencast datang, klik sampai', async () => {
    const headers: IncomingHttpHeaders[] = []
    const server = createServer((req, res) => { headers.push(req.headers); res.setHeader('content-type', 'text/html'); res.end(PAGE) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }))
    const port = (server.address() as AddressInfo).port
    const proxy = await startSsrfProxy({ allow: new Set([allowKey('127.0.0.1', port)]), webtermPort: 1 })
    cleanup.push(() => proxy.close())
    const dir = mkdtempSync(join(tmpdir(), 'wt-real-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const launched: Launched = await launchChromium({
      bin: found?.path ?? '', profileDir: dir, proxyServer: `http://127.0.0.1:${proxy.port}`,
    })
    cleanup.push(() => launched.kill())
    const cdp = await CdpClient.connect(launched.wsUrl)
    cleanup.push(() => cdp.close())

    await setupConnection(cdp)
    const { sessionId } = await createPageTarget(cdp, { ...DEFAULT_VIEWPORT })
    let frames = 0
    cdp.on('Page.screencastFrame', (p, sid) => { frames++; cdp.send(CDP.screencastFrameAck, { sessionId: p.sessionId }, sid).catch(ignoreClosed(CDP.screencastFrameAck, { sessionId: sid })) })
    await cdp.send(CDP.navigate, { url: `http://127.0.0.1:${port}/` }, sessionId)
    const ev = async <T>(expression: string): Promise<T> =>
      (await cdp.send<{ result: { value: T } }>(CDP.evaluate, { expression, returnByValue: true }, sessionId)).result.value
    for (let i = 0; i < 50 && !(await ev<boolean>('!!document.getElementById("b")')); i++) await sleep(POLL_MS)
    await cdp.send(CDP.startScreencast, { format: 'jpeg', quality: 60 }, sessionId)
    for (let i = 0; i < FRAME_WAIT_MS / POLL_MS && frames < 2; i++) await sleep(POLL_MS)
    // Klik setelah frame pertama, seperti viewer nyata (sebelum compositor menggambar, hit-test belum siap).
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send(CDP.mouse, { type, x: 100, y: 100, button: 'left', clickCount: 1 }, sessionId)
    }

    expect(await ev<boolean>('navigator.webdriver')).toBe(false)
    expect(await ev<string>('navigator.userAgent')).not.toContain('Headless')
    expect(headers.length).toBeGreaterThan(0)
    expect(headers[0]['user-agent']).not.toContain('Headless')
    expect(headers[0]['sec-ch-ua'] ?? '').not.toContain('Headless')
    expect(frames).toBeGreaterThan(1)
    expect(await ev<boolean>('window.clicked === true')).toBe(true)
  }, TEST_TIMEOUT_MS)
})
