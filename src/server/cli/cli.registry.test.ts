import { describe, expect, it } from 'vitest'
import { defineCapability } from '../capability/capability.define'
import { obj, S } from '../capability/capability.schema'
import { buildAgentContext, diffRegistry, formatAgentContext, formatDiff, snapshotOf, TOOL_INDEX } from './cli.registry'

const cap = (name: string, extra: Partial<Parameters<typeof defineCapability>[0]> = {}) => defineCapability({
  name, summary: `does ${name}`, tier: 'R0', scope: 'node', projections: ['control-http'], route: { method: 'POST', path: `/x/${name}` },
  input: obj({ nodeId: S.str() }), output: obj({}), ...extra,
})

describe('tool registry', () => {
  it('holds only capabilities with an HTTP binding, sorted by name', () => {
    const names = TOOL_INDEX.list().map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(['git.diff', 'node.close', 'browser.act', 'approval.request']))
    expect(names).toEqual([...names].sort())
    for (const c of TOOL_INDEX.list()) expect(c.route).toBeDefined()
  })

  it('version is a content hash: same registry same version, any change a new one', () => {
    const a = snapshotOf([cap('a.one'), cap('a.two')])
    expect(snapshotOf([cap('a.two'), cap('a.one')]).version).toBe(a.version)
    expect(snapshotOf([cap('a.one'), cap('a.two', { tier: 'R2' })]).version).not.toBe(a.version)
    expect(a.version).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe('diffRegistry', () => {
  it('reports added, removed and changed fields', () => {
    const before = snapshotOf([cap('a.keep'), cap('a.gone'), cap('a.tier')])
    const after = snapshotOf([cap('a.keep'), cap('a.tier', { tier: 'R2', input: obj({ nodeId: S.str(), more: S.bool() }) }), cap('a.new')])
    expect(diffRegistry(before, after)).toEqual({
      added: ['a.new'], removed: ['a.gone'], changed: [{ name: 'a.tier', fields: ['tier', 'input'] }],
    })
    expect(diffRegistry(after, after)).toEqual({ added: [], removed: [], changed: [] })
  })

  it('never seen = the whole registry is new', () => {
    const now = snapshotOf([cap('a.one'), cap('a.two')])
    expect(diffRegistry(null, now).added).toEqual(['a.one', 'a.two'])
    expect(formatDiff(null, now.version, diffRegistry(null, now))).toContain('+ a.one')
    expect(formatDiff(now.version, now.version, diffRegistry(now, now))).toContain('No changes')
  })
})

describe('buildAgentContext', () => {
  it('flags each capability allowed or not for the caller, from the injected policy answer', () => {
    const caps = [cap('a.read'), cap('a.close', { tier: 'R2', destructive: true })]
    const ctx = buildAgentContext('node:n1', (c) => (c.name === 'a.read' ? 'allow' : 'deny'), caps)
    expect(ctx).toMatchObject({ schemaVersion: 1, principal: 'node:n1', capabilityCount: 2, registryVersion: snapshotOf(caps).version })
    expect(ctx.capabilities.map((c) => [c.name, c.allowed, c.decision, c.tier])).toEqual([
      ['a.close', false, 'deny', 'R2'], ['a.read', true, 'allow', 'R0'],
    ])
    expect(ctx.capabilities[0]).toMatchObject({ destructive: true, input: caps[1].input })
    expect(formatAgentContext(ctx)).toMatch(/a\.close\s+R2\s+deny/)
  })
})
