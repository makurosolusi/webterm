// Adaptor penjaga navigasi: `NavigationGuard` (WS-02, `GuardResult`) -> `NavGuard` (WS-01, `BlockReason | null`).
// Dua WS menentukan bentuknya sendiri-sendiri; BrowserHost hanya butuh alasan blokir, bukan hostname/URL ternormalisasi.
import type { NavigationGuard } from './navigation.guard'
import type { NavGuard } from './browserHost.targets'

/** Bungkus guard WS-02 menjadi guard yang dipakai `BrowserHost`; null = lolos. */
export function toHostGuard(guard: NavigationGuard): NavGuard {
  return {
    check: (url) => { const r = guard.check(url); return r.ok ? null : r.reason },
    onFrameNavigated: (url) => { const r = guard.onFrameNavigated(url); return r.ok ? null : r.reason },
  }
}
