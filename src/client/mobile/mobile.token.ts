// Transport token for the /m PWA. The desktop keeps the token in sessionStorage (it should not
// outlive the tab), but an installed PWA starts a fresh session on every launch and iOS opens the
// manifest start_url without the `?token=` link, so /m keeps it in localStorage until "Sign out".
// It is then mirrored into sessionStorage, where the shared transport (`peekToken`) reads it, so
// every request below goes through the same client code as the desktop.
import { TOKEN_KEY, TOKEN_PARAM } from '../transportToken'

export const MOBILE_TOKEN_KEY = 'webterm.mobile.token'

interface Env { href: string; local: Storage | null; session: Storage | null; replace(url: string): void }

const safe = (get: () => Storage): Storage | null => { try { return get() } catch { return null } }

function browserEnv(): Env {
  return {
    href: location.href,
    local: safe(() => localStorage),
    session: safe(() => sessionStorage),
    replace: (url) => history.replaceState(null, '', url),
  }
}

/**
 * Moves a `?token=` link into storage (and out of the address bar); restores a remembered one.
 * `api.ts` (imported by the shared transport) may already have moved this launch's link token into
 * sessionStorage, so that one counts as fresh too and wins over the remembered token.
 */
export function adoptToken(env: Env = browserEnv()): void {
  const url = new URL(env.href)
  const fromUrl = url.searchParams.get(TOKEN_PARAM)
  const token = fromUrl || env.session?.getItem(TOKEN_KEY) || env.local?.getItem(MOBILE_TOKEN_KEY) || ''
  if (fromUrl) {
    url.searchParams.delete(TOKEN_PARAM)
    env.replace(url.pathname + url.search + url.hash)
  }
  if (!token) return
  try {
    env.local?.setItem(MOBILE_TOKEN_KEY, token)
    env.session?.setItem(TOKEN_KEY, token)
  } catch {
    // Storage full or blocked (Safari private mode): the token still works until the next launch.
  }
}

export function saveToken(token: string, env: Env = browserEnv()): void {
  try {
    env.local?.setItem(MOBILE_TOKEN_KEY, token)
    env.session?.setItem(TOKEN_KEY, token)
  } catch { /* see adoptToken */ }
}

export function forgetToken(env: Env = browserEnv()): void {
  try {
    env.local?.removeItem(MOBILE_TOKEN_KEY)
    env.session?.removeItem(TOKEN_KEY)
  } catch { /* nothing stored */ }
}
