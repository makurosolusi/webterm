import { describe, expect, it } from 'vitest'
import {
  MSG_AGENT_CANNOT_APPROVE,
  MSG_APPROVAL_BROWSER_ONLY,
  MSG_FORBIDDEN,
  MSG_UNAUTHORIZED,
  inboxErrorMessage,
} from './inboxTransport'
import { InboxApiError } from './inboxTypes'

const msg = (status: number, code: string) => inboxErrorMessage(new InboxApiError('x', status, code))

describe('inboxErrorMessage auth mapping', () => {
  it('maps each refusal code to its own honest text', () => {
    expect(msg(403, 'agent_cannot_approve')).toBe(MSG_AGENT_CANNOT_APPROVE)
    expect(msg(403, 'approval_browser_only')).toBe(MSG_APPROVAL_BROWSER_ONLY)
    expect(msg(401, 'unauthorized')).toBe(MSG_UNAUTHORIZED)
    expect(msg(403, 'forbidden')).toBe(MSG_FORBIDDEN)
    expect(msg(403, 'http_403')).toBe(MSG_FORBIDDEN) // refuseRequest answers plain text
    expect(msg(403, 'loopback_only')).toBe('Refused by the server (loopback_only).')
  })

  it('never tells the user to sign in: there is no login', () => {
    const cases: Array<[number, string]> = [[401, 'x'], [403, 'forbidden'], [403, 'agent_cannot_approve'], [403, 'approval_browser_only'], [403, 'other']]
    for (const [status, code] of cases) expect(msg(status, code)).not.toMatch(/sign in/i)
  })
})
