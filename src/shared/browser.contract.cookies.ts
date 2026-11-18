// Cookie import REST shapes (split out of browser.contract.ts). Declarations only; no response carries a cookie value.
export type CookieFormat = 'storageState' | 'netscape'
export interface CookieDomainInfo { domain: string; count: number; expiresAt?: number }
export interface CookiePreviewReq { format: CookieFormat; content: string }
export interface CookiePreviewResp {
  previewId: string; domains: Array<{ domain: string; count: number; hasSession: boolean }>; expiresAt: number
  /** Jumlah cookie login Google yang dilewati saat import (kebijakan Orca; lihat cookieImportPolicy). */
  googleSkipped?: number
}
export interface CookieCommitReq { previewId: string; domains: string[] }
export interface CookieCommitResp { imported: number; domains: string[] }
