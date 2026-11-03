import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Fixture, openFixture } from '../../centralTestFixture.testutil'
import { confirmPhrase } from '../../skills/skillLifecycle'
import { type SkillAdminStore, createSkillStore } from '../../skills/skillStore'
import { createRegistry } from '../toolRegistry'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import type { Tier, ToolCtx } from '../toolTypes'
import { createSkillDefs } from './skill.defs'

const input = { name: 'webterm-demo', description: 'Summarize status. Use when asked.', body: '1. Read the portfolio.', caps: ['portfolio.read'] }
const ON = { WEBTERM_CENTRAL_SKILLS: 'on', WEBTERM_CENTRAL_SKILL_PROPOSE: 'on' }
let f: Fixture
let root: string
let store: SkillAdminStore
let clock: number
const ctxOf = (env: Record<string, string> = ON, maxTier: Tier = 'R1'): ToolCtx => {
  const registry = createRegistry()
  for (const def of createSkillDefs(() => store)) registry.register(def)
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId: 'global', now: () => clock, env }
}

beforeEach(() => { f = openFixture(); root = mkdtempSync(join(tmpdir(), 'ws14d-')); clock = 1_700_000_000_000; store = createSkillStore({ db: f.db, root, now: () => clock }) })
afterEach(() => { f.close(); rmSync(root, { recursive: true, force: true }) })

describe('skill tool defs', () => {
  it('expose exactly list/load/propose and no activation tool', () => {
    const defs = createSkillDefs(() => store)
    expect(defs.map((d) => [d.name, d.tier])).toEqual([['skill.list', 'R0'], ['skill.load', 'R0'], ['skill.propose', 'R1']])
    expect(defs.some((d) => /approve|activate|rollback/.test(d.name))).toBe(false)
    expect(defs.every((d) => d.summary.length <= 120 && d.projectScoped === false)).toBe(true)
  })

  it('are off by default and propose also needs the skills flag', async () => {
    expect((await execTool(ctxOf({}), 'skill.list', {})).code).toBe('flag_off')
    expect((await execTool(ctxOf({}), 'skill.propose', input)).code).toBe('flag_off')
    expect((await execTool(ctxOf({ WEBTERM_CENTRAL_SKILL_PROPOSE: 'on' }), 'skill.propose', input)).code).toBe('flag_off')
    expect(store.list()).toEqual([])
    expect((await execTool(ctxOf({ WEBTERM_CENTRAL_SKILLS: 'on' }), 'skill.propose', input)).code).toBe('flag_off')
  })

  it('propose stores a draft only; load stays not_found until a human activates', async () => {
    const res = await execTool(ctxOf(), 'skill.propose', input)
    expect(res).toMatchObject({ ok: true, data: { name: 'webterm-demo', version: '1', status: 'proposed' } })
    expect(store.list('active')).toEqual([])
    expect((await execTool(ctxOf(), 'skill.load', { name: 'webterm-demo' })).code).toBe('not_found')
    const listed = await execTool(ctxOf(), 'skill.list', { status: 'proposed' })
    expect(listed.data?.skills).toEqual([{ name: 'webterm-demo', version: '1', status: 'proposed', origin: 'central' }])
    await store.evaluate('webterm-demo', '1')
    store.submit('webterm-demo', '1')
    store.approve('webterm-demo', '1', 'human:alice', confirmPhrase('webterm-demo', '1'))
    const loaded = await execTool(ctxOf(), 'skill.load', { name: 'webterm-demo' })
    expect(loaded).toMatchObject({ ok: true, data: { name: 'webterm-demo', version: '1' } })
    expect(String(loaded.data?.body)).toContain('Read the portfolio')
  })

  it('propose returns coded lint failures without echoing content, and the model cannot inject authority fields', async () => {
    const bad = await execTool(ctxOf(), 'skill.propose', { ...input, body: 'Run rm -rf build then read /etc/passwd' })
    expect(bad).toMatchObject({ ok: false, code: 'invalid', data: { issues: expect.arrayContaining(['danger', 'traversal']) } })
    expect(JSON.stringify(bad)).not.toContain('rm -rf')
    for (const key of ['approvedBy', 'actor', 'status', 'decision']) {
      const res = await execTool(ctxOf(), 'skill.propose', { ...input, [key]: 'human:alice' })
      expect(res.ok).toBe(false)
    }
    expect((await execTool(ctxOf(), 'skill.propose', { ...input, extra: 1 })).code).toBe('invalid_shape')
    expect((await execTool(ctxOf(), 'skill.propose', { ...input, caps: 'x' })).code).toBe('invalid_shape')
    expect(store.list()).toEqual([])
  })

  it('list validates and paginates; load refuses non-webterm names', async () => {
    store.installBuiltins()
    const page = await execTool(ctxOf(), 'skill.list', { limit: 2 })
    expect((page.data?.skills as unknown[]).length).toBe(2)
    expect((await execTool(ctxOf(), 'skill.list', { limit: 999 })).code).toBe('invalid_shape')
    expect((await execTool(ctxOf(), 'skill.list', { status: 'bogus' })).code).toBe('invalid_shape')
    expect((await execTool(ctxOf(), 'skill.load', { name: '../../etc/passwd' })).code).toBe('not_found')
    expect((await execTool(ctxOf(), 'skill.load', { name: 'frontend-design' })).code).toBe('not_found')
    expect((await execTool(ctxOf(), 'skill.load', { name: 'webterm-project-status' })).ok).toBe(true)
  })
})
