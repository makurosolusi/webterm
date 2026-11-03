import { describe, expect, it } from 'vitest'
import { cookieLogEntry } from './cookieRedact'

const CANARY = 'cv-canary-7f3a' // test-only

describe('cookieLogEntry', () => {
  it('emits only workspaceId, domains, count, action', () => {
    const cookies = [
      { domain: '.B.com', name: CANARY, value: CANARY }, { domain: 'b.com', name: 'x', value: CANARY }, { domain: 'a.org', value: CANARY },
    ]
    const e = cookieLogEntry('commit', 'ws1', cookies)
    expect(e).toEqual({ workspaceId: 'ws1', domains: ['a.org', 'b.com'], count: 3, action: 'commit' })
    expect(Object.keys(e).sort()).toEqual(['action', 'count', 'domains', 'workspaceId'])
    expect(JSON.stringify(e)).not.toContain(CANARY)
  })

  it('caps the domain list but keeps the true count', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ domain: `d${i}.com` }))
    const e = cookieLogEntry('preview', 'ws1', many)
    expect(e.domains).toHaveLength(20)
    expect(e.count).toBe(50)
  })
})
