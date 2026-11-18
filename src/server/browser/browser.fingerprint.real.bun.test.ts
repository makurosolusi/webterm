// Bun-only, Chrome NYATA, tanpa jaringan luar: apa yang dilihat server tujuan dari jalur peluncuran produksi (flags + proxy
// SSRF + target) konsisten dengan Chrome biasa: UA == Client Hints, bahasa == Accept-Language, cookie bertahan antar
// navigasi, dan preset perangkat menyebut mesin yang sama di UA, sec-ch-ua dan navigator.platform.
// Skip bersih bila tak ada Chromium headful. Lihat docs/decisions/browser-fingerprint.md.
import { afterAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDevice } from '../../shared/browser.devices'
import { CdpClient } from './cdp.client'
import { headlessReason } from './chromium.flags'
import { detectChromium, launchChromium } from './chromium.launch'
import { createPageTarget, DEFAULT_VIEWPORT, setupConnection } from './browserHost.targets'
import { deviceCommands, responsiveCommands } from './browserHost.device'
import { learnEngine } from './browserHost.device.identity'
import { allowKey } from './ssrf.allowlist'
import { childEnv } from '../childEnv'
import { startSsrfProxy } from './ssrf.proxy'

const found = detectChromium(process.env)
const TEST_TIMEOUT_MS = 90_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const RUNNABLE = found !== null && headlessReason(process.env) === null
const cleanup: Array<() => unknown> = []
afterAll(async () => { for (const c of cleanup.reverse()) await c() })

type Seen = Record<string, string | string[] | undefined>
const major = (s: string | undefined, re: RegExp): string | undefined => re.exec(s ?? '')?.[1]

describe('Chrome nyata: sidik jari konsisten', () => {
  if (!RUNNABLE) return
  test('header & JS konsisten, cookie bertahan, preset perangkat menyebut mesin yang sama', async () => {
    const seen: Seen[] = []
    const server = createServer((req, res) => {
      seen.push(req.headers)
      if (req.url === '/set') res.setHeader('set-cookie', 'probe=1; Max-Age=600; Path=/')
      res.setHeader('content-type', 'text/html'); res.end('<html><body>ok</body></html>')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }))
    const port = (server.address() as AddressInfo).port
    const proxy = await startSsrfProxy({ allow: new Set([allowKey('127.0.0.1', port)]), webtermPort: 1 })
    cleanup.push(() => proxy.close())
    const dir = mkdtempSync(join(tmpdir(), 'wt-fp-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    // The mock keychain only keeps the test hermetic (temp HOME has no login keychain); it adds no web-visible signal.
    const launched = await launchChromium({ bin: found?.path ?? '', profileDir: dir, proxyServer: `http://127.0.0.1:${proxy.port}` },
      { spawn: (b, a) => spawn(b, [...a, '--use-mock-keychain'], { env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'] }) })
    cleanup.push(() => launched.kill())
    const cdp = await CdpClient.connect(launched.wsUrl)
    cleanup.push(() => cdp.close())
    await setupConnection(cdp)
    const { sessionId } = await createPageTarget(cdp, { ...DEFAULT_VIEWPORT })
    const ev = async <T>(expression: string): Promise<T> =>
      (await cdp.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value
    const visit = async (path: string): Promise<Seen> => {
      const before = seen.length
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}${path}` }, sessionId)
      for (let i = 0; i < 60 && !seen.slice(before).some((h) => h.accept?.toString().includes('text/html')); i++) await sleep(100)
      return seen.slice(before).find((h) => h.accept?.toString().includes('text/html')) as Seen
    }

    // Default path: no override of any kind.
    const first = await visit('/set')
    const second = await visit('/second')
    expect(second.cookie).toBe('probe=1') // the profile keeps cookies between navigations
    const uaMajor = major(first['user-agent'] as string, /Chrome\/(\d+)/)
    expect(uaMajor).toBeDefined()
    expect(first['sec-ch-ua']).toContain(`v="${uaMajor}"`)
    expect(first['user-agent']).not.toContain('Headless')
    const lang = await ev<string[]>('navigator.languages')
    expect(String(first['accept-language']).split(',')[0]).toBe(lang[0]) // header and JS name the same first language
    const uad = await ev<{ platform: string; mobile: boolean }>('({platform: navigator.userAgentData.platform, mobile: navigator.userAgentData.mobile})')
    expect(first['sec-ch-ua-platform']).toBe(`"${uad.platform}"`)
    expect(first['sec-ch-ua-mobile']).toBe(uad.mobile ? '?1' : '?0')

    // Device mode: the preset names the real engine in UA, sec-ch-ua and navigator.platform; Responsive restores the plain UA.
    await learnEngine((m, p) => cdp.send(m, p, sessionId))
    for (const c of deviceCommands(resolveDevice({ id: 'pixel-8' })!)) await cdp.send(c.method, c.params, sessionId)
    const phone = await visit('/phone')
    expect(major(phone['user-agent'] as string, /Chrome\/(\d+)/)).toBe(uaMajor)
    expect(phone['sec-ch-ua']).toContain(`v="${uaMajor}"`)
    expect(phone['sec-ch-ua-platform']).toBe('"Android"')
    expect(phone['sec-ch-ua-mobile']).toBe('?1')
    expect(await ev<string>('navigator.platform')).toBe('Linux armv81')
    for (const c of responsiveCommands({ ...DEFAULT_VIEWPORT })) await cdp.send(c.method, c.params, sessionId)
    const back = await visit('/back')
    expect(back['user-agent']).toBe(first['user-agent'])
    expect(back['sec-ch-ua']).toBe(first['sec-ch-ua'])
    expect(await ev<string>('navigator.platform')).not.toBe('Linux armv81')
  }, TEST_TIMEOUT_MS)
})
