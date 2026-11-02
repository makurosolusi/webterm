import { describe, expect, it } from 'vitest'
import { approvalAuthAllowed } from './approvalAuth'

describe('approvalAuthAllowed', () => {
  it('denies token-free loopback by default', () => {
    expect(approvalAuthAllowed({})).toBe(false)
    expect(approvalAuthAllowed({ WEBTERM_TOKEN: '   ' })).toBe(false)
    expect(approvalAuthAllowed({ WEBTERM_ALLOW_LOOPBACK_APPROVAL: '1' })).toBe(true)
  })

  it('allows a configured root token or only the explicit demo opt-in', () => {
    expect(approvalAuthAllowed({ WEBTERM_TOKEN: 'root' })).toBe(true)
    expect(approvalAuthAllowed({ WEBTERM_ALLOW_LOOPBACK_APPROVAL: '0' })).toBe(false)
    expect(approvalAuthAllowed({ WEBTERM_ALLOW_LOOPBACK_APPROVAL: 'true' })).toBe(false)
  })
})
