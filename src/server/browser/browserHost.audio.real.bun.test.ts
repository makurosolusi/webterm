// Bun-only, Chrome NYATA, halaman lokal 127.0.0.1 saja: nada 440 Hz yang dimainkan halaman sampai sebagai frame audio lewat host + hub,
// dan tidak ada frame sebelum klien mengirim `audio on`. Skip bersih tanpa Chromium headful.
import { afterAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LeaseView } from '../../shared/browser.contract'
import { decodeAudioFrame } from '../../shared/browser.wire'
import type { AudioChunk } from '../../shared/browser.contract'
import { childEnv } from '../childEnv'
import { BrowserHost } from './browserHost.service'
import { createViewerHub } from './browserWs.viewers'
import type { GatewayHost, Viewer } from './browserWs.viewers'
import { headlessReason } from './chromium.flags'
import { detectChromium, launchChromium } from './chromium.launch'
import { stubGuard } from './fakeCdp.testkit'
import { allowKey } from './ssrf.allowlist'
import { startSsrfProxy } from './ssrf.proxy'

const found = detectChromium(process.env)
const TEST_TIMEOUT_MS = 90_000
const POLL_MS = 100
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TONE_HZ = 440 // test-only
const PAGE = `<body style="margin:0"><button style="width:400px;height:300px" onclick="go()">play</button><script>
let started=false
function go(){ if(started)return; started=true; const c=new AudioContext(); const o=c.createOscillator(); const g=c.createGain(); o.frequency.value=${TONE_HZ}; g.gain.value=0.5; o.connect(g); g.connect(c.destination); o.start() }
</script></body>`
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3]

const cleanup: Array<() => unknown> = []
afterAll(async () => { for (const c of cleanup.reverse()) await c() })
const RUNNABLE = found !== null && existsSync(found.path) && headlessReason(process.env) === null // a managed path that is not installed = skip, not fail
const leases: LeaseView = { holder: () => 'human', noteHumanInput: () => undefined, takeover: () => undefined }

describe('Chrome nyata: audio halaman sampai ke klien yang mendengarkan', () => {
  if (!RUNNABLE) return
  test('nada 440 Hz -> frame audio ber-streamKey dengan payload WebM non-senyap; nol frame sebelum audio on', async () => {
    const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }))
    const port = (server.address() as AddressInfo).port
    const proxy = await startSsrfProxy({ allow: new Set([allowKey('127.0.0.1', port)]), webtermPort: 1 })
    cleanup.push(() => proxy.close())
    const dir = mkdtempSync(join(tmpdir(), 'wt-audio-real-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const launched = await launchChromium({ bin: found?.path ?? '', profileDir: dir, proxyServer: `http://127.0.0.1:${proxy.port}` },
      { spawn: (bin, args) => spawn(bin, [...args, '--use-mock-keychain'], { env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'] }) })
    cleanup.push(() => launched.kill())

    const host = new BrowserHost({ launcher: { acquire: async () => launched.wsUrl, shutdown: () => undefined }, guard: stubGuard(), audio: () => true })
    cleanup.push(() => host.dispose())
    await host.open('n1', 'w1', `http://127.0.0.1:${port}/`)
    const hub = createViewerHub(host as unknown as GatewayHost, leases)
    const frames: AudioChunk[] = []
    const viewer: Viewer = { sink: { bufferedAmount: 0, sendBinary: (b) => { const c = decodeAudioFrame(b); if (c) frames.push(c); return true }, sendJson: () => undefined } }
    hub.join('n1', viewer)

    await sleep(1500) // page loaded; the viewer has not asked for audio yet
    const click = (type: 'down' | 'up') => host.input('n1', { t: 'mouse', type, x: 100, y: 100, button: 'left', buttons: type === 'down' ? 1 : 0, clickCount: 1, mods: 0, dx: 0, dy: 0 })
    expect(frames).toHaveLength(0) // nobody listens: nothing leaves the host
    hub.setAudio('n1', viewer, true) // Runtime is enabled lazily, on this first audio on; the capture script is installed in the loaded page then
    await sleep(1000)
    await click('down'); await click('up') // a forwarded click is a real user gesture: the page starts its AudioContext (now captured)
    await waitUntil(() => frames.reduce((n, f) => n + f.payload.length, 0) > 2000)
    await waitUntil(() => host.state('n1')?.audioActive === true)
    const first = frames.find((f) => f.seq === 0)
    expect(first?.streamKey).toMatch(/^[a-z0-9]+$/)
    expect([...(first?.payload.subarray(0, 4) ?? [])]).toEqual(EBML_MAGIC) // WebM header of the stream
    expect(new Set(frames.map((f) => f.streamKey)).size).toBe(1)
    hub.setAudio('n1', viewer, false)
  }, TEST_TIMEOUT_MS)
})

async function waitUntil(cond: () => boolean, ms = 15_000): Promise<void> {
  for (let i = 0; i < ms / POLL_MS && !cond(); i++) await sleep(POLL_MS)
  if (!cond()) throw new Error(`condition not met within ${ms} ms`)
}
