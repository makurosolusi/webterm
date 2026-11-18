// REST client for /api/browser/* (PLAN/BROWSER-CANVAS-b.md §4.5). Same credential as api.ts
// (the `wt_ui` session cookie). No response carries a cookie value; request bodies and response bodies are
// never echoed into errors.
import { BROWSER_REST_PREFIX, ENV_BROWSER } from '../shared/browser.contract'
import type {
  BrowserStatusResp, CookieCommitReq, CookieCommitResp, CookieDomainInfo, CookiePreviewReq, CookiePreviewResp,
} from '../shared/browser.contract'

/** REST failure; `code` is the server's stable error code (or `http_<status>`). */
export class BrowserApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'BrowserApiError'
  }
}

async function errorCode(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    const e = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
    const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : e
    if (typeof code === 'string' && code !== '') return code
  } catch {
    // Non-JSON error body: the status alone is the signal.
  }
  return `http_${res.status}`
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) {
    const code = await errorCode(res)
    throw new BrowserApiError(`${method} ${url} failed (${res.status} ${code})`, res.status, code)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export const request = <T>(method: string, path: string, body?: unknown): Promise<T> => call<T>(method, `${BROWSER_REST_PREFIX}${path}`, body)

const seg = encodeURIComponent

/** Server capability/status for the browser feature. */
export const getBrowserStatus = () => request<BrowserStatusResp>('GET', '/status')

/** Per-node agent-control flag on the server (the node's saved flag is written by the caller). */
export const setAgentControl = (nodeId: string, enabled: boolean) =>
  request<void>('POST', `/${seg(nodeId)}/agent-control`, { enabled })

/** Human takes the lease back from the agent. */
export const takeoverLease = (nodeId: string) =>
  request<{ lease: string }>('POST', `/${seg(nodeId)}/lease`, { holder: 'human' })

/** Stored cookie domains for a workspace (names and counts only). */
export const listCookieDomains = (workspaceId: string) =>
  request<{ domains: CookieDomainInfo[] }>('GET', `/${seg(workspaceId)}/cookies/domains`)

/** Upload a cookie file for preview; the server keeps it in memory only. */
export const previewCookies = (workspaceId: string, req: CookiePreviewReq) =>
  request<CookiePreviewResp>('POST', `/${seg(workspaceId)}/cookies/preview`, req)

/** Import the chosen domains of a preview. */
export const commitCookies = (workspaceId: string, req: CookieCommitReq) =>
  request<CookieCommitResp>('POST', `/${seg(workspaceId)}/cookies/commit`, req)

/** Remove stored cookies for one domain, or all when `domain` is omitted. The domain rides in the
 *  path (`/cookies/<domain>`): the server never reads a DELETE body (`cappedBodyGetter`). */
export const clearCookies = (workspaceId: string, domain?: string) =>
  request<void>('DELETE', `/${seg(workspaceId)}/cookies${domain === undefined ? '' : `/${seg(domain)}`}`)

const ENV_SETTINGS_PATH = '/api/settings/env'

/**
 * Tambah `host:port` ke allowlist host privat (`WEBTERM_BROWSER_ALLOW_HOSTS`) lewat Pengaturan, bukan env:
 * baca daftar tersimpan, gabung tanpa duplikat, tulis lewat PUT yang sama dengan halaman Pengaturan.
 * Runtime browser membaca ulang allowlist tiap navigasi, jadi berlaku tanpa restart.
 */
export async function allowBrowserHosts(entries: string[]): Promise<void> {
  const st = await call<{ entries: Array<{ key: string; value: string }> }>('GET', ENV_SETTINGS_PATH)
  const cur = st.entries.find((e) => e.key === ENV_BROWSER.allowHosts)?.value ?? ''
  const merged = [...new Set([...cur.split(/[\s,]+/).filter(Boolean), ...entries])].join(',')
  await call('PUT', ENV_SETTINGS_PATH, { set: { [ENV_BROWSER.allowHosts]: merged }, unset: [] })
}
