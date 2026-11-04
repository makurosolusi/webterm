// Kebijakan import cookie: login Google TIDAK diimpor (Google mengikat sesi ke perangkat asal; cookie
// yang dipindah diinvalidasi/ditandai). Dipakai di satu titik (preview store) sehingga preview & commit sama.
// Portions adapted from Orca (https://github.com/stablyai/orca), MIT License, Copyright (c) 2026 Lovecast Inc. — see THIRD_PARTY_NOTICES.md
// Port dari Orca `src/main/browser/cookies/browser-cookie-import-policy.ts` (GOOGLE_SOURCE_BOUND_COOKIE_NAMES,
// normalizeCookieDomain, NON_TRANSPLANTABLE_DOMAINS/isNonTransplantableCookieDomain, isGoogleSourceBoundCookie)
// dan urutan filter `browser-cookie-import-pipeline.ts` importValidatedCookies. Dimodifikasi: tanpa tldts
// (tak dibutuhkan untuk dua fungsi ini) dan filter digabung jadi satu partisi.

const GOOGLE_SOURCE_BOUND_COOKIE_NAMES = new Set(['SIDCC', '__Secure-1PSIDCC', '__Secure-3PSIDCC', '__Secure-STRP', 'AEC'])

/** Domain cookie -> hostname kanonik huruf kecil tanpa titik depan; null bila bukan domain cookie yang sah. */
export function normalizeCookieDomain(domain: string): string | null {
  const candidate = domain.trim().replace(/^\.+/, '')
  const isBracketedIpv6 = candidate.startsWith('[') && candidate.endsWith(']')
  if (!candidate || /[/\\@?#%]/.test(candidate) || (!isBracketedIpv6 && candidate.includes(':'))) return null
  try {
    const parsed = new URL(`https://${candidate}/`)
    const normalized = parsed.hostname.toLowerCase()
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash ||
      normalized.endsWith('.') || normalized.includes('..')) return null
    return normalized
  } catch {
    return null // bukan hostname yang bisa diurai -> bukan domain Google; perlakuan domain lain tak berubah
  }
}

// Sesi Google terikat perangkat; YouTube menerima import dan tetap boleh. Entri = registrable domain kanonik.
const NON_TRANSPLANTABLE_DOMAINS = ['google.com'] as const

/** True bila domain berada di keluarga google.com (termasuk accounts.google.com). */
export function isNonTransplantableCookieDomain(domain: string): boolean {
  const normalized = normalizeCookieDomain(domain)
  if (!normalized) return false
  return NON_TRANSPLANTABLE_DOMAINS.some((root) => normalized === root || normalized.endsWith(`.${root}`))
}

/** True bila cookie integritas Google yang terikat browser asal (SIDCC, AEC, ...). */
export function isGoogleSourceBoundCookie(name: string, domain: string): boolean {
  if (!GOOGLE_SOURCE_BOUND_COOKIE_NAMES.has(name)) return false
  const normalized = normalizeCookieDomain(domain)
  return normalized === 'google.com' || normalized?.endsWith('.google.com') === true
}

/** Pisahkan cookie yang boleh diimpor dari cookie login Google yang dilewati (jumlah saja yang dilaporkan). */
export function partitionImportableCookies<C extends { name: string; domain: string }>(cookies: readonly C[]): { importable: C[]; googleSkipped: number } {
  const importable = cookies.filter((c) => !isGoogleSourceBoundCookie(c.name, c.domain) && !isNonTransplantableCookieDomain(c.domain))
  return { importable, googleSkipped: cookies.length - importable.length }
}
