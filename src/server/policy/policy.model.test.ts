import { describe, expect, it } from 'vitest'
import type { Workspace, WsNode } from '../../shared/workspace'
import { cableGrants } from './policy.cable'
import { evaluate, isAgentPrincipal, principalKind, stricter, wildcardMatch, type Grant } from './policy.model'

const rule = (id: string, subject: string, capability: string, effect: Grant['effect'], extra: Partial<Grant> = {}): Grant =>
  ({ id, subject, capability, scope: '*', effect, expiresAt: null, origin: 'human-ui', createdBy: 'human-ui', createdAt: 0, ...extra })
const q = (principal: string, capability: string, resource?: string) => ({ principal, capability, resource, now: 1000 })

describe('wildcardMatch (OpenCode syntax)', () => {
  it('* matches any run including empty, ? exactly one, the rest literally', () => {
    expect(wildcardMatch('browser.*', 'browser.act')).toBe(true)
    expect(wildcardMatch('browser.*', 'browser.')).toBe(true)
    expect(wildcardMatch('browser.*', 'browserXact')).toBe(false)
    expect(wildcardMatch('node:?', 'node:a')).toBe(true)
    expect(wildcardMatch('node:?', 'node:ab')).toBe(false)
    expect(wildcardMatch('a+b', 'aab')).toBe(false)
  })
})

describe('evaluate: last match wins', () => {
  const rules = [rule('r1', 'node:*', '*', 'deny'), rule('r2', 'node:a1', 'browser.*', 'allow'), rule('r3', 'node:a1', 'browser.act', 'ask')]
  it('the later, more specific rule decides', () => {
    expect(evaluate(rules, q('node:a1', 'browser.act'))).toMatchObject({ effect: 'ask', ruleId: 'r3' })
    expect(evaluate(rules, q('node:a1', 'browser.read'))).toMatchObject({ effect: 'allow', ruleId: 'r2' })
    expect(evaluate(rules, q('node:a2', 'browser.read'))).toMatchObject({ effect: 'deny', ruleId: 'r1' })
  })
  it('a later broad rule overrides an earlier narrow one (order, not specificity)', () => {
    expect(evaluate([...rules, rule('r4', 'node:*', '*', 'deny')], q('node:a1', 'browser.read'))).toMatchObject({ effect: 'deny', ruleId: 'r4' })
  })
  it('no match fails closed; expired rules and non-matching scope are skipped', () => {
    expect(evaluate([], q('central', 'x'))).toEqual({ effect: 'deny', reason: 'no rule matches' })
    expect(evaluate([rule('e', 'central', '*', 'allow', { expiresAt: 1000 })], q('central', 'x')).effect).toBe('deny')
    const scoped = [rule('s', 'central', '*', 'allow', { scope: 'project:p1' })]
    expect(evaluate(scoped, q('central', 'x', 'project:p1')).effect).toBe('allow')
    expect(evaluate(scoped, q('central', 'x', 'project:p2')).effect).toBe('deny')
    expect(evaluate(scoped, q('central', 'x')).effect).toBe('deny')
  })
})

describe('principals', () => {
  it('parses the five kinds and flags agents', () => {
    expect(principalKind('human-ui')).toBe('human-ui')
    expect(principalKind('telegram:123')).toBe('telegram')
    expect(principalKind('node:')).toBeNull()
    expect(principalKind('root')).toBeNull()
    expect(['central', 'node:a', 'routine:r'].every(isAgentPrincipal)).toBe(true)
    expect(isAgentPrincipal('human-ui') || isAgentPrincipal('telegram:1')).toBe(false)
  })
  it('stricter picks deny < ask < allow', () => {
    const allow = { effect: 'allow' as const, reason: 'a' }
    const ask = { effect: 'ask' as const, reason: 'b' }
    expect(stricter(allow, ask)).toBe(ask)
    expect(stricter(ask, allow)).toBe(ask)
  })
})

describe('cableGrants', () => {
  const node = (id: string, kind: WsNode['kind']): WsNode => ({ id, kind, x: 0, y: 0 })
  const ws = (bridges: Workspace['bridges']): Workspace[] =>
    [{ id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('a1', 'agent'), node('a2', 'agent'), node('b1', 'browser')], bridges, updatedAt: 0 }]
  it('an edge agent<->browser is a browser.* grant for that browser only; no edge, no grant', () => {
    const wired = ws([{ id: 'e', source: 'b1', target: 'a1', kind: 'context' }])
    expect(cableGrants(wired, 'a1')).toMatchObject([{ subject: 'node:a1', capability: 'browser.*', scope: 'node:b1', effect: 'allow', origin: 'cable' }])
    expect(cableGrants(wired, 'a2')).toEqual([])
    expect(cableGrants(ws([{ id: 'e', source: 'a1', target: 'a2', kind: 'context' }]), 'a1')).toEqual([])
  })
})
