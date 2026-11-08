import { describe, expect, it } from 'vitest'
import { createProxyDenials, PROXY_DENIAL_TTL_MS, toHostGuard } from './browser.guardAdapter'
import { createNavigationGuard } from './navigation.guard'
import { parseAllowHosts } from './ssrf.allowlist'

const WEBTERM_PORT = 8700 // test-only
const allow = parseAllowHosts('', WEBTERM_PORT)
if (!allow.ok) throw new Error('empty allowlist must parse')
const guard = toHostGuard(createNavigationGuard({ allow: allow.hosts, webtermPort: WEBTERM_PORT }))

describe('toHostGuard', () => {
  it('returns null for public URLs and the blank page', () => {
    expect(guard.check('https://example.com/a')).toBeNull()
    expect(guard.onFrameNavigated('about:blank')).toBeNull()
  })
  it('maps blocked results to their BlockReason', () => {
    expect(guard.check('http://127.0.0.1:9999/')).toBe('private_host')
    expect(guard.check(`http://localhost:${WEBTERM_PORT}/`)).toBe('not_allowed_port')
    expect(guard.check('file:///etc/passwd')).toBe('scheme')
    expect(guard.onFrameNavigated('http://10.0.0.5/')).toBe('private_host')
  })
})

describe('proxy denials', () => {
  it('reports a recent proxy refusal on that host once, normalized, and forgets stale ones', () => {
    let t = 0
    const denials = createProxyDenials(() => t)
    const g = toHostGuard(createNavigationGuard({ allow: allow.hosts, webtermPort: WEBTERM_PORT }), denials)
    denials.record('Nope.Invalid', 'dns_fail')
    expect(g.onFrameNavigated('https://other.example/')).toBeNull()
    expect(g.onFrameNavigated('http://nope.invalid/x')).toBe('dns_fail')
    expect(g.onFrameNavigated('http://nope.invalid/x')).toBeNull() // handed out once
    denials.record('nope.invalid', 'dns_fail')
    t += PROXY_DENIAL_TTL_MS + 1
    expect(g.onFrameNavigated('http://nope.invalid/')).toBeNull()
    expect(g.check('http://nope.invalid/')).toBeNull() // the pre-navigation check never consults the proxy
  })
})
