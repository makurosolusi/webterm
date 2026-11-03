import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_VERBS,
  CapabilityStore,
  MAX_TTL_MS,
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  allows,
  clampTtl,
  isValidResource,
  type CapabilityRecord,
} from './capabilities'

const T0 = 1_700_000_000_000

function mintNodeRead(overrides: Partial<Parameters<CapabilityStore['mint']>[0]> = {}) {
  const store = new CapabilityStore()
  const token = store.mint({ verb: 'node.read', resource: 'node:a', ...overrides }, T0)
  return { store, token }
}

describe('mint / verify', () => {
  it('mints a wcap_ prefixed base64url token and verifies it', () => {
    const { store, token } = mintNodeRead()
    expect(token.startsWith('wcap_')).toBe(true)
    expect(token.slice(5)).toMatch(/^[A-Za-z0-9_-]+$/)
    const record = store.verify(token, T0)
    expect(record).toBeDefined()
    expect(record).toMatchObject({ verb: 'node.read', resource: 'node:a', expiresAt: T0 + DEFAULT_TTL_MS })
    expect(record?.id).toMatch(/^cap_[0-9a-f]{16}$/)
  })

  it('returns undefined for unknown or malformed tokens', () => {
    const { store } = mintNodeRead()
    expect(store.verify('wcap_unknown', T0)).toBeUndefined()
    expect(store.verify('', T0)).toBeUndefined()
    expect(store.verify('not-a-token', T0)).toBeUndefined()
    expect(store.size()).toBe(1)
  })

  it('does not store the raw token', () => {
    const { store, token } = mintNodeRead()
    // Hanya record yang terekspos; tidak ada field yang sama dengan token mentah.
    const record = store.verify(token, T0)!
    expect(JSON.stringify(record)).not.toContain(token.slice(5))
  })

  it('stores qualifier and mintedBy', () => {
    const { store, token } = mintNodeRead({
      qualifier: { agentIds: ['ag1'], cwdPrefix: '/repo' },
      mintedBy: 'central',
    })
    expect(store.verify(token, T0)).toMatchObject({
      qualifier: { agentIds: ['ag1'], cwdPrefix: '/repo' },
      mintedBy: 'central',
    })
  })

  it('rejects "*" for verbs other than node.read', () => {
    const store = new CapabilityStore()
    expect(() => store.mint({ verb: 'node.close', resource: '*' }, T0)).toThrow(/\*.*node\.read/)
    expect(store.mint({ verb: 'node.read', resource: '*' }, T0)).toMatch(/^wcap_/)
  })

  it('rejects unknown verbs and malformed resources', () => {
    const store = new CapabilityStore()
    expect(() => store.mint({ verb: 'node.explode' as never, resource: 'node:a' }, T0)).toThrow(/unknown verb/)
    expect(() => store.mint({ verb: 'node.read', resource: 'nonsense' }, T0)).toThrow(/invalid resource/)
    expect(() => store.mint({ verb: 'node.read', resource: 'node:' }, T0)).toThrow(/invalid resource/)
  })
})

describe('expiry', () => {
  it('is alive one ms before expiry and dead exactly at the boundary', () => {
    const { store, token } = mintNodeRead({ ttlMs: 1000 })
    expect(store.verify(token, T0 + 999)).toBeDefined()
    expect(store.verify(token, T0 + 1000)).toBeUndefined()
    // Record kedaluwarsa dibuang saat verify gagal.
    expect(store.size()).toBe(0)
  })

  it('uses the default TTL when ttlMs is omitted', () => {
    const { store, token } = mintNodeRead()
    expect(store.verify(token, T0 + DEFAULT_TTL_MS - 1)).toBeDefined()
    expect(store.verify(token, T0 + DEFAULT_TTL_MS)).toBeUndefined()
  })

  it('clamps ttlMs into [MIN_TTL_MS, MAX_TTL_MS]', () => {
    const { store, token } = mintNodeRead({ ttlMs: 10 * MAX_TTL_MS })
    expect(store.verify(token, T0 + MAX_TTL_MS - 1)).toBeDefined()
    expect(store.verify(token, T0 + MAX_TTL_MS)).toBeUndefined()

    const tiny = mintNodeRead({ ttlMs: 0 })
    expect(tiny.store.verify(tiny.token, T0 + MIN_TTL_MS - 1)).toBeDefined()
    expect(tiny.store.verify(tiny.token, T0 + MIN_TTL_MS)).toBeUndefined()

    expect(clampTtl(undefined)).toBe(DEFAULT_TTL_MS)
    expect(clampTtl(Number.NaN)).toBe(DEFAULT_TTL_MS)
    expect(clampTtl(-500)).toBe(MIN_TTL_MS)
    expect(clampTtl(2.9)).toBe(2)
    expect(clampTtl(MAX_TTL_MS + 1)).toBe(MAX_TTL_MS)
  })
})

describe('allows: verb and resource', () => {
  const record = (over: Partial<CapabilityRecord> = {}): CapabilityRecord => ({
    id: 'cap_1',
    verb: 'node.prompt',
    resource: 'node:a',
    expiresAt: T0 + 1000,
    ...over,
  })

  it('requires the exact verb', () => {
    expect(allows(record(), 'node.prompt', 'node:a')).toBe(true)
    expect(allows(record(), 'node.read', 'node:a')).toBe(false)
    expect(allows(record(), 'node.close', 'node:a')).toBe(false)
  })

  it('rejects malformed requested resources', () => {
    expect(allows(record(), 'node.prompt', 'garbage')).toBe(false)
  })

  it('matches the exact resource only', () => {
    expect(allows(record(), 'node.prompt', 'node:a')).toBe(true)
    expect(allows(record(), 'node.prompt', 'node:b')).toBe(false)
    expect(allows(record({ resource: 'node:ab' }), 'node.prompt', 'node:a')).toBe(false)
  })

  it('allows workspace/project prefix scope with "/" boundary', () => {
    const ws = record({ resource: 'workspace:ws1' })
    expect(allows(ws, 'node.prompt', 'workspace:ws1')).toBe(true)
    expect(allows(ws, 'node.prompt', 'workspace:ws1/node:a')).toBe(true)
    expect(allows(ws, 'node.prompt', 'workspace:ws10/node:a')).toBe(false)
    expect(allows(ws, 'node.prompt', 'workspace:ws2/node:a')).toBe(false)
    expect(allows(ws, 'node.prompt', 'node:a')).toBe(false)

    const pr = record({ resource: 'project:p1' })
    expect(allows(pr, 'node.prompt', 'project:p1/node:a')).toBe(true)
    expect(allows(pr, 'node.prompt', 'workspace:p1/node:a')).toBe(false)
  })

  it('restricts "*" to node.read', () => {
    const star = record({ verb: 'node.read', resource: '*' })
    expect(allows(star, 'node.read', 'node:a')).toBe(true)
    expect(allows(star, 'node.read', 'node:b')).toBe(true)
    expect(allows(star, 'node.prompt', 'node:a')).toBe(false)
    const starPrompt = record({ verb: 'node.prompt', resource: '*' })
    expect(allows(starPrompt, 'node.prompt', 'node:a')).toBe(false)
  })
})

describe('allows: qualifier', () => {
  const record = (over: Partial<CapabilityRecord> = {}): CapabilityRecord => ({
    id: 'cap_1',
    verb: 'node.prompt',
    resource: 'node:a',
    expiresAt: T0 + 1000,
    ...over,
  })

  it('requires the agent id to be listed', () => {
    const r = record({ qualifier: { agentIds: ['ag1', 'ag2'] } })
    expect(allows(r, 'node.prompt', 'node:a', { agentId: 'ag1' })).toBe(true)
    expect(allows(r, 'node.prompt', 'node:a', { agentId: 'ag3' })).toBe(false)
    expect(allows(r, 'node.prompt', 'node:a', {})).toBe(false)
  })

  it('requires the cwd to start with the prefix', () => {
    const r = record({ qualifier: { cwdPrefix: '/repo/app' } })
    expect(allows(r, 'node.prompt', 'node:a', { cwd: '/repo/app' })).toBe(true)
    expect(allows(r, 'node.prompt', 'node:a', { cwd: '/repo/app/src' })).toBe(true)
    expect(allows(r, 'node.prompt', 'node:a', { cwd: '/repo/application' })).toBe(false)
    expect(allows(r, 'node.prompt', 'node:a', { cwd: '/repo/app2' })).toBe(false)
    expect(allows(r, 'node.prompt', 'node:a', {})).toBe(false)

    const trailing = record({ qualifier: { cwdPrefix: '/repo/app/' } })
    expect(allows(trailing, 'node.prompt', 'node:a', { cwd: '/repo/app/src' })).toBe(true)
  })

  it('requires all qualifiers to pass', () => {
    const r = record({ qualifier: { agentIds: ['ag1'], cwdPrefix: '/repo' } })
    expect(allows(r, 'node.prompt', 'node:a', { agentId: 'ag1', cwd: '/repo/x' })).toBe(true)
    expect(allows(r, 'node.prompt', 'node:a', { agentId: 'ag1', cwd: '/other' })).toBe(false)
    expect(allows(r, 'node.prompt', 'node:a', { agentId: 'ag2', cwd: '/repo/x' })).toBe(false)
  })

  it('ignores qualifiers when the record has none', () => {
    expect(allows(record(), 'node.prompt', 'node:a', { agentId: 'who', cwd: '/' })).toBe(true)
  })

  it('applies qualifiers to a "*" grant instead of skipping them', () => {
    const star = record({
      verb: 'node.read',
      resource: '*',
      qualifier: { agentIds: ['ag1'], cwdPrefix: '/repo' },
    })
    expect(allows(star, 'node.read', 'node:a', { agentId: 'ag1', cwd: '/repo/x' })).toBe(true)
    expect(allows(star, 'node.read', 'node:a', { agentId: 'ag2', cwd: '/repo/x' })).toBe(false)
    expect(allows(star, 'node.read', 'node:a', {})).toBe(false)
  })
})

describe('revoke / sweep / clear', () => {
  it('revokes a live token and reports unknown tokens', () => {
    const { store, token } = mintNodeRead()
    expect(store.size()).toBe(1)
    expect(store.revoke(token)).toBe(true)
    expect(store.verify(token, T0)).toBeUndefined()
    expect(store.size()).toBe(0)
    expect(store.revoke(token)).toBe(false)
    expect(store.revoke('wcap_nope')).toBe(false)
  })

  it('sweeps only expired tokens', () => {
    const store = new CapabilityStore()
    const short = store.mint({ verb: 'node.read', resource: 'node:a', ttlMs: 1000 }, T0)
    const long = store.mint({ verb: 'node.read', resource: 'node:b', ttlMs: 60_000 }, T0)
    expect(store.sweep(T0 + 999)).toBe(0)
    expect(store.size()).toBe(2)
    expect(store.sweep(T0 + 1000)).toBe(1)
    expect(store.size()).toBe(1)
    expect(store.verify(short, T0 + 1000)).toBeUndefined()
    expect(store.verify(long, T0 + 1000)).toBeDefined()
  })

  it('clears everything', () => {
    const store = new CapabilityStore()
    const token = store.mint({ verb: 'node.read', resource: 'node:a' }, T0)
    store.clear()
    expect(store.size()).toBe(0)
    expect(store.verify(token, T0)).toBeUndefined()
  })

  it('issues unique tokens and ids per mint', () => {
    const store = new CapabilityStore()
    const a = store.mint({ verb: 'node.read', resource: 'node:a' }, T0)
    const b = store.mint({ verb: 'node.read', resource: 'node:a' }, T0)
    expect(a).not.toBe(b)
    expect(store.verify(a, T0)?.id).not.toBe(store.verify(b, T0)?.id)
  })
})

describe('isValidResource', () => {
  it('accepts supported shapes', () => {
    expect(isValidResource('*')).toBe(true)
    expect(isValidResource('node:a')).toBe(true)
    expect(isValidResource('workspace:ws1')).toBe(true)
    expect(isValidResource('project:p1')).toBe(true)
  })
  it('rejects other shapes', () => {
    expect(isValidResource('node:')).toBe(false)
    expect(isValidResource('node')).toBe(false)
    expect(isValidResource('')).toBe(false)
    expect(isValidResource('agent:ag1')).toBe(false)
  })
})

describe('approval verbs', () => {
  it('are listed and mintable for project resources', () => {
    const store = new CapabilityStore()
    const verbs = [
      'approval.request',
      'approval.decide',
      'approval.consume',
      'approval.read',
    ] as const
    for (const verb of verbs) {
      expect(CAPABILITY_VERBS).toContain(verb)
      const token = store.mint({ verb, resource: 'project:p1' }, T0)
      expect(store.verify(token, T0)).toMatchObject({ verb, resource: 'project:p1' })
      expect(allows(store.verify(token, T0)!, verb, 'project:p1')).toBe(true)
      expect(allows(store.verify(token, T0)!, verb, 'project:p2')).toBe(false)
    }
  })

  it('leave node verb semantics unchanged and reject "*"', () => {
    const store = new CapabilityStore()
    expect(() => store.mint({ verb: 'approval.decide', resource: '*' }, T0)).toThrow(/\*.*node\.read/)
    const node = store.mint({ verb: 'node.prompt', resource: 'node:a' }, T0)
    expect(allows(store.verify(node, T0)!, 'node.prompt', 'node:a')).toBe(true)
    expect(allows(store.verify(node, T0)!, 'approval.decide', 'node:a')).toBe(false)
  })
})

describe('browser verbs and sliding renewal', () => {
  it('lists browser.read and browser.act as mintable verbs scoped to a node', () => {
    expect(CAPABILITY_VERBS).toContain('browser.read')
    expect(CAPABILITY_VERBS).toContain('browser.act')
    const store = new CapabilityStore()
    const token = store.mint({ verb: 'browser.act', resource: 'node:b1' }, T0)
    const rec = store.verify(token, T0)!
    expect(allows(rec, 'browser.act', 'node:b1')).toBe(true)
    expect(allows(rec, 'browser.read', 'node:b1')).toBe(false) // verb harus persis sama
    expect(allows(rec, 'browser.act', 'node:b2')).toBe(false)
  })

  it('refuses a wildcard resource for browser verbs', () => {
    const store = new CapabilityStore()
    expect(() => store.mint({ verb: 'browser.read', resource: '*' })).toThrow(/only allowed for node\.read/)
  })

  it('renew slides expiry forward, never shortens it, and refuses dead tokens', () => {
    const store = new CapabilityStore()
    const token = store.mint({ verb: 'browser.read', resource: 'node:b1', ttlMs: 1_000 }, T0)
    expect(store.renew(token, 5_000, T0 + 500)).toBe(true)
    expect(store.verify(token, T0 + 4_000)).toBeDefined()
    expect(store.renew(token, 1, T0 + 600)).toBe(true) // ttl lebih pendek tidak memendekkan
    expect(store.verify(token, T0 + 4_000)).toBeDefined()
    expect(store.verify(token, T0 + 6_000)).toBeUndefined()
    expect(store.renew(token, 5_000, T0 + 7_000)).toBe(false)
    expect(store.renew('wcap_unknown')).toBe(false)
  })
})
