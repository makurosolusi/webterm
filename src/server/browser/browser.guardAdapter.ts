// Adaptor penjaga navigasi: `NavigationGuard` (WS-02, `GuardResult`) -> `NavGuard` (WS-01, `BlockReason | null`).
// Dua WS menentukan bentuknya sendiri-sendiri; BrowserHost hanya butuh alasan blokir, bukan hostname/URL ternormalisasi.
// Plus the egress proxy's own refusals: a plain-http request it refuses (DNS failure, private IP after resolve) reaches
// Chromium as an ordinary 403 page, so the main-frame commit is the first moment the host can name the real reason.
import type { BlockReason } from '../../shared/browser.contract'
import type { NavigationGuard } from './navigation.guard'
import type { NavGuard } from './browserHost.targets'
import { normalizeHost } from './ssrf.allowlist'

/** How long a proxy refusal waits for its page to commit (the proxy answers in milliseconds; this only bounds staleness). */
export const PROXY_DENIAL_TTL_MS = 10_000

/** Recent refusals of the egress proxy, by host; `take` hands one out once. */
export function createProxyDenials(now: () => number = Date.now) {
  const recent = new Map<string, { reason: BlockReason; at: number }>()
  return {
    record(host: string, reason: BlockReason): void { recent.set(normalizeHost(host), { reason, at: now() }) },
    take(host: string): BlockReason | null {
      const key = normalizeHost(host)
      const hit = recent.get(key)
      recent.delete(key)
      return hit && now() - hit.at <= PROXY_DENIAL_TTL_MS ? hit.reason : null
    },
  }
}
export type ProxyDenials = ReturnType<typeof createProxyDenials>

/** Bungkus guard WS-02 menjadi guard yang dipakai `BrowserHost`; null = lolos. `denials` = refusals of the egress proxy. */
export function toHostGuard(guard: NavigationGuard, denials?: ProxyDenials): NavGuard {
  return {
    check: (url) => { const r = guard.check(url); return r.ok ? null : r.reason },
    onFrameNavigated: (url) => {
      const r = guard.onFrameNavigated(url)
      if (!r.ok) return r.reason
      return denials ? denials.take(hostOf(url)) : null
    },
  }
}

const hostOf = (url: string): string => { try { return new URL(url).hostname } catch { return '' } }
