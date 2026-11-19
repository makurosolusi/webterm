// test-only: an in-memory /api/browser server for the profile UI tests (fetch stub that records every call).
import { vi } from 'vitest'
import type { ProfileAccount } from '../shared/browser.accounts'
import type { BrowserProfile } from '../shared/browser.profile'

export const prof = (id: string, name: string, extra: Partial<BrowserProfile> = {}): BrowserProfile =>
  ({ id, name, color: 'teal', shade: 'default', createdAt: 1, workspaceId: null, live: false, nodeCount: 0, cookieDomains: 0, ...extra })

export interface FakeServer { calls: string[]; profiles: BrowserProfile[]; fail: Record<string, { status: number; error: string }>; live: number; maxLive: number
  /** What POST .../accounts/refresh answers. */
  refreshed: ProfileAccount[]
  /** The `accountsEnabled` flag of the list answer. */
  accountsEnabled: boolean
}

/** `fail` maps "METHOD /path" to an error answer. Everything else answers 200 (or 204 for DELETE). */
export function fakeBrowserServer(profiles: BrowserProfile[]): FakeServer {
  const s: FakeServer = { calls: [], profiles, fail: {}, live: 0, maxLive: 8, refreshed: [], accountsEnabled: true }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const key = `${method} ${url}`
    s.calls.push(key)
    const bad = s.fail[key]
    if (bad) return new Response(JSON.stringify({ error: bad.error }), { status: bad.status })
    if (url.startsWith('/api/browser/status')) return new Response(JSON.stringify({ enabled: true, binFound: true, live: s.live, maxLive: s.maxLive, agentEnabled: false, cookieImportEnabled: true }))
    if (method === 'GET' && url.startsWith('/api/browser/profiles') && url.includes('/cookies')) return new Response(JSON.stringify({ domains: [{ domain: 'a.com', count: 2 }] }))
    if (method === 'GET' && url.includes('/export')) return new Response('{"cookies":[]}')
    if (method === 'POST' && url.includes('/accounts/refresh')) return new Response(JSON.stringify({ accounts: s.refreshed }))
    if (method === 'GET' && url.startsWith('/api/browser/profiles')) return new Response(JSON.stringify({ profiles: s.profiles, accountsEnabled: s.accountsEnabled }))
    if (url.endsWith('/cookies/preview')) return new Response(JSON.stringify({ previewId: 'pv1', expiresAt: 1, googleSkipped: 3, blocked: [{ domain: 'google.com', count: 3, reason: 'google_source_bound' }], domains: [{ domain: 'b.com', count: 4, hasSession: true }] }))
    if (url.endsWith('/cookies/import')) return new Response(JSON.stringify({ imported: 4, skipped: 3, reasons: ['google_source_bound'], domains: ['b.com'] }))
    if (method === 'POST' && url === '/api/browser/profiles') return new Response(JSON.stringify(prof('bp-new', 'Created')), { status: 201 })
    if (method === 'POST' && url.endsWith('/profile')) return new Response(JSON.stringify({ profileId: 'x' }))
    if (method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(JSON.stringify(prof('bp-x', 'X')))
  }))
  return s
}
