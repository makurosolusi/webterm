// Credential proxy lifecycle: persisted token/port reuse and port-conflict recovery. Temp dirs only.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'webterm-credproxy-life-'))
process.env.WEBTERM_DATA_DIR = ROOT

const { activeEndpoint, startCredentialProxy, stopCredentialProxy } = await import('./credentialProxy.lifecycle')

let dir: string
type Served = import('./credentialProxy.server').ProxyServer
declare const Bun: { serve(opts: Record<string, unknown>): Served }
let blocker: Served | null = null
beforeEach(() => { dir = mkdtempSync(join(ROOT, 'd-')) })
afterEach(async () => {
  await stopCredentialProxy()
  await blocker?.stop(true)
  blocker = null
})

const stored = (name: string): string => readFileSync(join(dir, 'credential-proxy', name), 'utf8').trim()
const none = (): null => null

describe('credential proxy lifecycle', () => {
  test('first start stores a token and the chosen port with 0600 files, and serves on loopback', async () => {
    let started: unknown = null
    const ep = startCredentialProxy({ dataDir: dir, resolveUpstream: none, onStarted: (e) => { started = e } })
    expect(started).toEqual(ep)
    expect(activeEndpoint()).toEqual(ep)
    expect(ep.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(ep.token.length).toBeGreaterThan(39)
    expect(stored('TOKEN')).toBe(ep.token)
    expect(`http://127.0.0.1:${stored('PORT')}`).toBe(ep.url)
    expect(statSync(join(dir, 'credential-proxy', 'TOKEN')).mode & 0o777).toBe(0o600)
    const res = await fetch(`${ep.url}/v1/messages`, { headers: { 'x-api-key': ep.token } })
    expect(res.status).toBe(503) // no upstream configured: proxy is up and authenticated us
  })

  test('start is idempotent while running', () => {
    const a = startCredentialProxy({ dataDir: dir, resolveUpstream: none })
    expect(startCredentialProxy({ dataDir: dir, resolveUpstream: none })).toBe(a)
  })

  test('restart reuses the stored token and port; stop clears the active endpoint', async () => {
    const a = startCredentialProxy({ dataDir: dir, resolveUpstream: none })
    await stopCredentialProxy()
    expect(activeEndpoint()).toBeNull()
    const b = startCredentialProxy({ dataDir: dir, resolveUpstream: none })
    expect(b).toEqual(a)
  })

  test('a taken stored port yields a new port, stored, with the callback and no real-key fallback', async () => {
    const a = startCredentialProxy({ dataDir: dir, resolveUpstream: none })
    await stopCredentialProxy()
    const oldPort = Number(stored('PORT'))
    blocker = Bun.serve({ hostname: '127.0.0.1', port: oldPort, fetch: () => new Response('taken') })
    let change: { oldPort: number; newPort: number } | null = null
    const b = startCredentialProxy({ dataDir: dir, resolveUpstream: none, onPortChanged: (c) => { change = c } })
    expect(b.token).toBe(a.token)
    expect(b.url).not.toBe(a.url)
    expect(change).toEqual({ oldPort, newPort: Number(stored('PORT')) })
    expect(b.url).toBe(`http://127.0.0.1:${change!.newPort}`)
  })
})

process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* temp cleanup at exit is best effort */ } })
