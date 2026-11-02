import { describe, expect, it } from 'vitest'

import { UNKNOWN_PEER, TRUST_PROXY_ENV, trustProxyEnabled, webhookPeerKey } from './webhookPeer'

const ON = { [TRUST_PROXY_ENV]: 'on' } as NodeJS.ProcessEnv
const OFF = {} as NodeJS.ProcessEnv

function req(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress: string | undefined = '10.0.0.7'
) {
  return { socket: { remoteAddress }, headers }
}

describe('trustProxyEnabled', () => {
  it('accepts only the literal on, case- and whitespace-insensitive', () => {
    expect(trustProxyEnabled(ON)).toBe(true)
    expect(trustProxyEnabled({ [TRUST_PROXY_ENV]: ' ON ' } as NodeJS.ProcessEnv)).toBe(true)
    for (const value of ['off', '1', 'true', 'yes', '']) {
      expect(trustProxyEnabled({ [TRUST_PROXY_ENV]: value } as NodeJS.ProcessEnv)).toBe(false)
    }
    expect(trustProxyEnabled(OFF)).toBe(false)
  })
})

describe('webhookPeerKey', () => {
  it('uses the socket address and ignores a spoofed x-forwarded-for by default', () => {
    expect(webhookPeerKey(req({ 'x-forwarded-for': '203.0.113.9' }), OFF)).toBe('10.0.0.7')
    expect(webhookPeerKey(req({ 'x-forwarded-for': '203.0.113.9' }), { [TRUST_PROXY_ENV]: 'off' } as NodeJS.ProcessEnv)).toBe(
      '10.0.0.7'
    )
    // x-real-ip is never consulted, and neither is anything else header-shaped.
    expect(webhookPeerKey(req({ 'x-real-ip': '203.0.113.9' }), OFF)).toBe('10.0.0.7')
    expect(webhookPeerKey(req({ 'x-real-ip': '203.0.113.9' }), ON)).toBe('10.0.0.7')
  })

  it('uses the first x-forwarded-for hop when the proxy is trusted', () => {
    expect(webhookPeerKey(req({ 'x-forwarded-for': '203.0.113.9' }), ON)).toBe('203.0.113.9')
    expect(webhookPeerKey(req({ 'x-forwarded-for': '  203.0.113.9 , 10.0.0.1, 10.0.0.2' }), ON)).toBe(
      '203.0.113.9'
    )
    // A repeated header arrives as an array; only its first element can carry the client address.
    expect(webhookPeerKey(req({ 'x-forwarded-for': ['198.51.100.4, 10.0.0.1', '10.0.0.2'] }), ON)).toBe(
      '198.51.100.4'
    )
  })

  it('accepts an IPv6 literal when the proxy is trusted', () => {
    expect(webhookPeerKey(req({ 'x-forwarded-for': '2001:db8::1' }), ON)).toBe('2001:db8::1')
    expect(webhookPeerKey(req({ 'x-forwarded-for': '::1' }), ON)).toBe('::1')
  })

  it('falls back to the socket address for empty, missing, or invalid forwarded values', () => {
    for (const value of [undefined, '', '   ', ', 10.0.0.1', 'not-an-ip', '203.0.113.9:443', '999.1.1.1', '[::1]']) {
      expect(webhookPeerKey(req({ 'x-forwarded-for': value }), ON)).toBe('10.0.0.7')
    }
  })

  it('reports unknown when there is no address at all', () => {
    expect(webhookPeerKey({ headers: {} }, ON)).toBe(UNKNOWN_PEER)
    expect(webhookPeerKey({ headers: { 'x-forwarded-for': 'bad' } }, ON)).toBe(UNKNOWN_PEER)
    expect(webhookPeerKey({ socket: null, headers: {} }, OFF)).toBe(UNKNOWN_PEER)
  })
})
