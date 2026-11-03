// Teks status overlay node browser. Murni; hanya hostname yang pernah ditampilkan (tanpa URL berquery).
import type { BlockReason, BrowserErrorCode, BrowserState } from '../shared/browser.contract'
import { hostOnly } from '../shared/browser.url'

export interface BrowserErr { code: BrowserErrorCode; hostname?: string }

const BLOCK_TEXT: Record<BlockReason, string> = {
  scheme: 'Only http and https pages can be opened.',
  private_host: 'This address is on a private network and is blocked.',
  dns_fail: 'Could not resolve this host.',
  not_allowed_port: 'This port is not allowed.',
  no_binary: 'No Chromium found on the server. Set WEBTERM_BROWSER_BIN.',
  disabled: 'The browser is disabled on this server.',
  max_live: 'Too many live browsers. Hide another one first.',
}

const ERROR_TEXT: Record<BrowserErrorCode, string> = {
  lease_agent: 'The agent is driving this browser. Take over to use it.',
  lease_human: 'You are in control of this browser.',
  human_active: 'You are using this browser right now.',
  stale_ref: 'The page changed. Try again.',
  no_binary: BLOCK_TEXT.no_binary,
  disabled: BLOCK_TEXT.disabled,
  blocked: 'This address is blocked.',
  not_found: 'This browser session no longer exists.',
  too_large: 'That was too large to send.',
  bad_request: 'The server rejected that input.',
  crashed: 'The page crashed. Reload to retry.',
}

/** Kode galat yang tidak hilang sendiri (butuh tindakan operator/pengguna). */
export const STICKY_ERRORS: ReadonlySet<BrowserErrorCode> = new Set(['no_binary', 'disabled', 'crashed'])

export interface BrowserNotice { tone: 'info' | 'error'; text: string }

/** Satu pesan status untuk overlay, atau null bila halaman tampil normal. */
export function browserNotice(i: { state?: BrowserState; error?: BrowserErr; connected: boolean }): BrowserNotice | null {
  const { state, error } = i
  const host = (h?: string) => (h ? ` (${h})` : '')
  if (state?.blocked) {
    return { tone: 'error', text: BLOCK_TEXT[state.blocked] + (state.url ? host(hostOnly(state.url)) : '') }
  }
  if (error) return { tone: 'error', text: ERROR_TEXT[error.code] + host(error.code === 'blocked' ? error.hostname : undefined) }
  if (!i.connected) return { tone: 'info', text: 'Reconnecting…' }
  if (!state) return { tone: 'info', text: 'Connecting…' }
  return null
}
