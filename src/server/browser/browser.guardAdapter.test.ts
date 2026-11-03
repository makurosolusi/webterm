import { describe, expect, it } from 'vitest'
import { toHostGuard } from './browser.guardAdapter'
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
