import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COOKIE_BODY_MAX_BYTES } from '../shared/browser.contract'
import type { BrowserStatusResp } from '../shared/browser.contract'
import { createCookiePreviewStore } from './browser/cookieImport.preview'
import type { BrowserCookie } from './browser/cookieImport.parse'
import { createCookieVault } from './browser/cookieVault.store'
import { BodyReadError } from './cappedRequestBody'
import { logBus } from './logs'
import { handleBrowserApi } from './browserApi'
import type { BrowserApiDeps } from './browserApi'

const CANARY = 'br-canary-9d41' // test-only: nilai cookie sintetis
const store = { cookies: [
  { name: 'sid', value: CANARY, domain: '.a.com', path: '/', expires: -1, httpOnly: true, secure: true },
  { name: 'tok', value: CANARY, domain: 'b.org', path: '/', expires: 1900000000, httpOnly: false, secure: false },
  { name: 'x', value: CANARY, domain: 'c.net', path: '/', expires: -1, httpOnly: false, secure: false },
] }
const STATE = JSON.stringify(store)
const json = (v: unknown) => () => Promise.resolve(JSON.stringify(v))
const none = () => Promise.resolve('')

let base: string
let status: BrowserStatusResp
let injected: BrowserCookie[]
let removed: Array<string | undefined>
let agentSet: Array<[string, boolean]>
let leaseLog: string[]
let d: BrowserApiDeps

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bapi-'))
  status = { enabled: true, binFound: true, live: 0, maxLive: 3, agentEnabled: true, cookieImportEnabled: true }
  injected = []; removed = []; agentSet = []; leaseLog = []
  const secrets = new Map<string, string>()
  d = {
    status: () => status,
    vault: createCookieVault({ secrets: { read: (k) => secrets.get(k) ?? null, write: (k, v) => void secrets.set(k, v), remove: (k) => void secrets.delete(k) }, baseDir: base }),
    preview: createCookiePreviewStore(),
    injector: { inject: async (_w, c) => void injected.push(...c), remove: async (_w, dom) => void removed.push(dom) },
    lease: { holder: () => 'human', takeover: (n) => void leaseLog.push(`takeover:${n}`), release: (n) => void leaseLog.push(`release:${n}`) },
    setAgentControl: (n, e) => void agentSet.push([n, e]),
    profiles: {} as BrowserApiDeps['profiles'], // test-only: profile routes have their own suite (browserApi.profiles.test.ts)
    setNodeProfile: async () => ({ ok: false, code: 'profile_not_found' }),
  }
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const call = (m: string, p: string, body: () => Promise<string> = none) => handleBrowserApi(m, p, body, d)
const preview = (ws = 'ws1') => call('POST', `/api/browser/${ws}/cookies/preview`, json({ format: 'storageState', content: STATE }))

describe('routing + flags', () => {
  it('ignores paths outside /api/browser/', async () => {
    expect(await call('GET', '/api/workspaces')).toBe(null)
  })

  it('flag off: status answers enabled=false, everything else is 404 disabled', async () => {
    status = { ...status, enabled: false }
    expect((await call('GET', '/api/browser/status'))?.body).toEqual(status)
    for (const [m, p] of [['POST', '/api/browser/n1/lease'], ['POST', '/api/browser/n1/agent-control'], ['GET', '/api/browser/ws1/cookies/domains'], ['DELETE', '/api/browser/ws1/cookies']]) {
      expect(await call(m, p, json({ holder: 'human' }))).toEqual({ status: 404, body: { error: 'disabled' } })
    }
  })

  it('rejects unsafe ids, bad escapes and unknown routes', async () => {
    expect((await call('POST', '/api/browser/..%2Fx/lease', json({ holder: 'human' })))?.status).toBe(400)
    expect((await call('GET', '/api/browser/..%2Fx/cookies/domains'))?.status).toBe(400)
    expect((await call('GET', '/api/browser/%E0%A4%A/cookies/domains'))?.status).toBe(400)
    expect((await call('GET', '/api/browser/n1/nope'))?.status).toBe(404)
    expect((await call('POST', '/api/browser/status'))?.status).toBe(405)
  })
})

describe('lease + agent-control', () => {
  it('takeover only for holder=human', async () => {
    expect(await call('POST', '/api/browser/n1/lease', json({ holder: 'human' }))).toEqual({ status: 200, body: { lease: 'human' } })
    expect(leaseLog).toEqual(['takeover:n1'])
    expect((await call('POST', '/api/browser/n1/lease', json({ holder: 'agent' })))?.status).toBe(400)
    expect(leaseLog).toEqual(['takeover:n1'])
  })

  it('agent-control: 204 + stored; off releases the lease; on is refused when agent env is off; non-boolean is 400', async () => {
    expect(await call('POST', '/api/browser/n1/agent-control', json({ enabled: true }))).toEqual({ status: 204 })
    expect(await call('POST', '/api/browser/n1/agent-control', json({ enabled: false }))).toEqual({ status: 204 })
    expect(agentSet).toEqual([['n1', true], ['n1', false]])
    expect(leaseLog).toEqual(['release:n1'])
    expect((await call('POST', '/api/browser/n1/agent-control', json({ enabled: 'yes' })))?.status).toBe(400)
    status = { ...status, agentEnabled: false }
    expect((await call('POST', '/api/browser/n1/agent-control', json({ enabled: true })))?.status).toBe(404)
    expect(agentSet.length).toBe(2)
  })
})

describe('cookies', () => {
  it('preview keeps content in memory only and never echoes values', async () => {
    const r = await preview()
    expect(r?.status).toBe(200)
    expect((r?.body as { domains: unknown[] }).domains).toEqual([
      { domain: 'a.com', count: 1, hasSession: true }, { domain: 'b.org', count: 1, hasSession: false }, { domain: 'c.net', count: 1, hasSession: true },
    ])
    expect(JSON.stringify(r)).not.toContain(CANARY)
    expect(readdirSync(base)).toEqual([]) // nol berkas ditulis oleh preview
    expect(injected).toEqual([])
  })

  it('commit with a domain subset injects and vaults only that subset', async () => {
    const { previewId } = (await preview())?.body as { previewId: string }
    const r = await call('POST', '/api/browser/ws1/cookies/commit', json({ previewId, domains: ['A.com', 'c.net'] }))
    expect(r).toEqual({ status: 200, body: { imported: 2, domains: ['a.com', 'c.net'] } })
    expect(injected.map((c) => c.domain).sort()).toEqual(['.a.com', 'c.net'])
    expect(d.vault.load('ws1').map((c) => c.domain).sort()).toEqual(['.a.com', 'c.net'])
    expect(JSON.stringify(r)).not.toContain(CANARY)
    // preview sekali pakai
    expect((await call('POST', '/api/browser/ws1/cookies/commit', json({ previewId, domains: ['b.org'] })))?.status).toBe(404)
  })

  it('commit: unknown/foreign preview 404, bad body 400, no matching domain 400, injector failure leaves vault untouched', async () => {
    const { previewId } = (await preview('ws1'))?.body as { previewId: string }
    expect((await call('POST', '/api/browser/ws2/cookies/commit', json({ previewId, domains: ['a.com'] })))?.status).toBe(404)
    expect((await call('POST', '/api/browser/ws1/cookies/commit', json({ previewId, domains: [] })))?.status).toBe(400)
    expect((await call('POST', '/api/browser/ws1/cookies/commit', json({ previewId, domains: ['zzz.io'] })))?.status).toBe(400)
    const p2 = (await preview('ws1'))?.body as { previewId: string }
    d.injector.inject = async () => { throw new Error('cdp down') }
    await expect(call('POST', '/api/browser/ws1/cookies/commit', json({ previewId: p2.previewId, domains: ['a.com'] }))).rejects.toThrow('cdp down')
    expect(d.vault.listDomains('ws1')).toEqual([])
  })

  it('domains lists names + counts only; DELETE clears vault and profile (one domain, then all)', async () => {
    const { previewId } = (await preview())?.body as { previewId: string }
    await call('POST', '/api/browser/ws1/cookies/commit', json({ previewId, domains: ['a.com', 'b.org', 'c.net'] }))
    const list = await call('GET', '/api/browser/ws1/cookies/domains')
    expect((list?.body as { domains: Array<{ domain: string; count: number }> }).domains.map((x) => `${x.domain}:${x.count}`)).toEqual(['a.com:1', 'b.org:1', 'c.net:1'])
    expect(JSON.stringify(list)).not.toContain(CANARY)

    expect(await call('DELETE', '/api/browser/ws1/cookies', json({ domain: 'b.org' }))).toEqual({ status: 204 })
    expect(await call('DELETE', '/api/browser/ws1/cookies/c.net')).toEqual({ status: 204 })
    expect(d.vault.listDomains('ws1').map((x) => x.domain)).toEqual(['a.com'])
    expect(await call('DELETE', '/api/browser/ws1/cookies')).toEqual({ status: 204 })
    expect(d.vault.listDomains('ws1')).toEqual([])
    expect(removed).toEqual(['b.org', 'c.net', undefined])
    expect((await call('DELETE', '/api/browser/ws1/cookies', json({ domain: 5 })))?.status).toBe(400)
  })

  it('import flag off: preview/commit 404, domains + DELETE still work (rollback path)', async () => {
    status = { ...status, cookieImportEnabled: false }
    expect(await preview()).toEqual({ status: 404, body: { error: 'disabled' } })
    expect((await call('POST', '/api/browser/ws1/cookies/commit', json({ previewId: 'x', domains: ['a'] })))?.status).toBe(404)
    expect((await call('GET', '/api/browser/ws1/cookies/domains'))?.status).toBe(200)
    expect((await call('DELETE', '/api/browser/ws1/cookies'))?.status).toBe(204)
  })

  it('size limits: oversize content 413, getter cap 413, stream failure 400, malformed input 400 without echo', async () => {
    const big = 'x'.repeat(COOKIE_BODY_MAX_BYTES + 1)
    expect((await call('POST', '/api/browser/ws1/cookies/preview', json({ format: 'netscape', content: big })))?.status).toBe(413)
    expect((await call('POST', '/api/browser/ws1/cookies/preview', () => Promise.reject(new BodyReadError('too_large'))))?.status).toBe(413)
    expect((await call('POST', '/api/browser/ws1/cookies/preview', () => Promise.reject(new BodyReadError('read_failed'))))?.status).toBe(400)
    const bad = await call('POST', '/api/browser/ws1/cookies/preview', () => Promise.resolve(`{"format":"storageState","content":"${CANARY}`))
    expect(bad?.status).toBe(400)
    const badContent = await call('POST', '/api/browser/ws1/cookies/preview', json({ format: 'storageState', content: `not json ${CANARY}` }))
    expect(badContent?.status).toBe(400)
    expect(JSON.stringify([bad, badContent])).not.toContain(CANARY)
    expect((await call('POST', '/api/browser/ws1/cookies/preview', json({ format: 'csv', content: 'x' })))?.status).toBe(400)
    expect((await call('POST', '/api/browser/ws1/cookies/preview', () => Promise.resolve('[]')))?.status).toBe(400)
  })

  it('logs carry domains + counts but never cookie values', async () => {
    const { previewId } = (await preview())?.body as { previewId: string }
    await call('POST', '/api/browser/ws1/cookies/commit', json({ previewId, domains: ['a.com'] }))
    await call('POST', '/api/browser/ws1/cookies/preview', json({ format: 'storageState', content: `bad ${CANARY}` }))
    const entries = logBus.query({ channel: 'browser.cookies' })
    expect(entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(entries)).not.toContain(CANARY)
  })
})
