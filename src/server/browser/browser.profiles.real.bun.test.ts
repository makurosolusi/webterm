// Bun-only, REAL Chromium (headless, mock keychain): two profiles are two processes with separate cookie jars, and the
// same profile reuses its process. Registered only when a Chromium binary exists, so CI without one stays green.
import { afterAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENV_BROWSER } from '../../shared/browser.contract'
import { childEnv } from '../childEnv'
import { CdpClient } from './cdp.client'
import { createCookieInjector } from './browser.cookieInjector'
import { createChromiumPool, detectChromium } from './chromium.launch'
import type { BrowserLauncher } from './chromium.launch'

const RUNNABLE = detectChromium(process.env) !== null
const TEST_TIMEOUT_MS = 90_000
const cleanup: Array<() => unknown> = []
afterAll(async () => { for (const c of cleanup.reverse()) await c() })

// Same reason as chromium.real.bun.test.ts: the temp HOME has no login keychain, so Chrome's cookie-key lookup would stall.
const mockKeychain = (bin: string, args: string[]) => spawn(bin, [...args, '--use-mock-keychain'], { env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'] })

describe('real Chromium: profiles are isolated', () => {
  if (!RUNNABLE) return
  test('cookie injected into profile A is invisible to profile B; same profile = same process', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'wt-realprof-'))
    const pool: BrowserLauncher = createChromiumPool({
      env: { ...process.env, [ENV_BROWSER.headless]: 'on' }, dataRoot, proxyServer: () => 'http://127.0.0.1:9', deps: { spawn: mockKeychain },
    })
    cleanup.push(() => { pool.shutdown(); rmSync(dataRoot, { recursive: true, force: true }) })
    const injector = createCookieInjector({ launcher: pool })
    await injector.inject('prof-a', [{ name: 'sid', value: 'account-a', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true }])
    const urlA = await pool.acquire('prof-a')
    expect(await pool.acquire('prof-a')).toBe(urlA) // same profile = the same process
    const urlB = await pool.acquire('prof-b')
    expect(urlB).not.toBe(urlA) // another profile = its own process
    expect([pool.isLive?.('prof-a'), pool.isLive?.('prof-b')]).toEqual([true, true])
    const jar = async (url: string): Promise<string[]> => {
      const cdp = await CdpClient.connect(url)
      try { return (await cdp.send<{ cookies: Array<{ value: string }> }>('Storage.getCookies', {})).cookies.map((c) => c.value) } finally { cdp.close() }
    }
    expect(await jar(urlA)).toEqual(['account-a'])
    expect(await jar(urlB)).toEqual([])
  }, TEST_TIMEOUT_MS)
})
