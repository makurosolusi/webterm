// Names shared by the canvas link capture pieces (shims, session env, route, auth). Dependency-free so
// `auth.ts` and the shim builders can import it without a cycle.
import { ENV_BROWSER } from '../../shared/browser.contract'
import { flagOr } from '../envFlag'

/** Settings switch (Settings > Browser): terminal links open in the canvas browser. Default on. */
export const ENV_CAPTURE_LINKS = ENV_BROWSER.captureLinks
/** Env var holding the PATH of the limited link-open header file of a plain terminal session (never the token). */
export const LINK_HEADERS_ENV = 'WEBTERM_LINK_HEADERS'
/** Header carrying the limited "open a URL in my canvas" credential: `<mac>.<nodeId>`. Accepted on `LINK_OPEN_PATH` only. */
export const LINK_TOKEN_HEADER = 'x-webterm-link-token'
/** The one route the limited credential opens. */
export const LINK_OPEN_PATH = '/api/link-open'
/** Skips the capture shims (set while exec-ing the real opener, so no opener can loop back into a shim). */
export const LINK_BYPASS_ENV = 'WEBTERM_OPEN_BYPASS'
/** The BROWSER handler. */
export const OPEN_COMMAND = 'webterm-open'
/** Opener names that get a shim: programs call these to open a link (`xdg-open` and friends on Linux, `open` on macOS). */
export const OPENER_SHIMS = ['open', 'xdg-open', 'sensible-browser', 'x-www-browser', 'gnome-open'] as const

/** True unless the switch is explicitly off. */
export const captureLinksOn = (env: Record<string, string | undefined> = process.env): boolean => flagOr(env[ENV_CAPTURE_LINKS], true)
