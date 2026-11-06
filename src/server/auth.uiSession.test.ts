// sec-208-1 lock: the `wt_ui` cookie opens /api only same-origin. Cookies ignore ports (RFC 6265), so a
// page on the dev-server proxy port (PORT+1, arbitrary npm code) carries the cookie too: it must not count.
import { describe, expect, it } from 'vitest'
import { UI_SESSION_COOKIE, authorizeRequest } from './auth'

const SELF = '127.0.0.1:8700'
const LIVE = 'live-session-test-only' // test-only
const isUiSession = (v: string) => v === LIVE

function gate(headers: Record<string, string>, opts: { cookie?: string; validator?: boolean } = {}): boolean {
  return authorizeRequest({
    headers: { host: SELF, ...headers, ...(opts.cookie ? { cookie: `app=1; ${UI_SESSION_COOKIE}=${opts.cookie}` } : {}) },
    expectedToken: 'root-token-test-only', // test-only: token mode, so only the cookie can let these through
    pathname: '/api/workspaces',
    isNodeToken: () => false,
    ...(opts.validator === false ? {} : { isUiSession }),
  })
}

describe('authorizeRequest: UI session cookie', () => {
  it('a live cookie from the webterm page itself is enough in token mode', () => {
    expect(gate({ origin: `http://${SELF}`, 'sec-fetch-site': 'same-origin' }, { cookie: LIVE })).toBe(true)
    expect(gate({}, { cookie: LIVE })).toBe(true) // same-origin GET: browsers may omit Origin
  })

  it('refused from the proxy port, a same-site frame, a foreign Origin, or with a dead/absent cookie', () => {
    expect(gate({ origin: 'http://127.0.0.1:8701' }, { cookie: LIVE })).toBe(false)
    expect(gate({ 'sec-fetch-site': 'same-site' }, { cookie: LIVE })).toBe(false)
    expect(gate({ origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' }, { cookie: LIVE })).toBe(false)
    expect(gate({ origin: `http://${SELF}` }, { cookie: 'expired' })).toBe(false)
    expect(gate({ origin: `http://${SELF}` })).toBe(false)
    expect(gate({ origin: `http://${SELF}` }, { cookie: LIVE, validator: false })).toBe(false)
  })
})
