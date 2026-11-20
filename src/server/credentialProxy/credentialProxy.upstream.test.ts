import { describe, expect, it } from 'vitest'
import { isAllowedPath, rawTarget, resolveTarget } from './credentialProxy.upstream'
import type { Upstream } from './credentialProxy.types'

const up = (baseUrl: string): Upstream => ({ baseUrl, kind: 'xApiKey', secret: 'k', headers: {} })

describe('isAllowedPath', () => {
  it.each([
    ['/v1/messages', true],
    ['/v1/messages?beta=true', true],
    ['/v1/messages/count_tokens', true],
    ['/v1/models/claude-x:y', true],
    ['/v2/messages', false],
    ['/messages', false],
    ['/v1/../admin', false],
    ['/v1/a/../b', false],
    ['/v1/./a', false],
    ['/v1//a', false],
    ['//evil.com/v1/a', false],
    ['http://evil.com/v1/a', false],
    ['/v1/%2e%2e/admin', false],
    ['/v1/%2E%2E/admin', false],
    ['/v1/a%2fb', false],
    ['/v1/a%5cb', false],
    ['/v1/a\\b', false],
    ['/v1/a@evil.com', false],
    ['/v1/a%00', false],
    ['/v1/a b', false],
    ['*', false],
    ['', false],
  ])('%s -> %s', (target, ok) => { expect(isAllowedPath(target)).toBe(ok) })
})

describe('rawTarget', () => {
  it('keeps the path as sent and strips scheme and host', () => {
    expect(rawTarget('http://127.0.0.1:9/v1/messages?x=1')).toBe('/v1/messages?x=1')
    expect(rawTarget('http://127.0.0.1:9/v1/%2e%2e/a')).toBe('/v1/%2e%2e/a')
  })
})

describe('resolveTarget', () => {
  it('builds the URL on the configured origin, keeping a base path prefix', () => {
    const t = resolveTarget(() => up('https://gw.example.com/anthropic/'), '/v1/messages?beta=true')
    expect(t.ok && t.url.href).toBe('https://gw.example.com/anthropic/v1/messages?beta=true')
  })
  it('answers no_upstream when none is configured or the base URL is unusable', () => {
    expect(resolveTarget(() => null, '/v1/messages')).toEqual({ ok: false, code: 'no_upstream', status: 503 })
    expect(resolveTarget(() => up('not a url'), '/v1/messages')).toMatchObject({ ok: false, code: 'no_upstream' })
    expect(resolveTarget(() => up('file:///etc'), '/v1/messages')).toMatchObject({ ok: false, code: 'no_upstream' })
  })
  it('rejects a bad path before consulting the upstream', () => {
    let called = false
    const r = resolveTarget(() => { called = true; return up('https://a.com') }, '/v1/../x')
    expect(r).toEqual({ ok: false, code: 'bad_request', status: 400 })
    expect(called).toBe(false)
  })
})
