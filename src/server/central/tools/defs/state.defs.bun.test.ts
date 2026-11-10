// Bun-only: registerAll pulls bun:sqlite modules.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { registerCa2Tools } from '../registerAll'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { Tier, ToolCtx } from '../toolTypes'
import { STATE_DEFS } from './state.defs'

let f: Fixture
beforeEach(() => { f = openFixture(); seedPortfolio(f.db) })
afterEach(() => f.close())

function ctx(conversationId: string, maxTier: Tier = 'R1'): ToolCtx {
  const registry = createRegistry()
  for (const def of STATE_DEFS) registry.register(def)
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId, now: () => 9, env: {} }
}
const GLOBAL = 'central:global'
const PROJECT = 'central:project:p1'

describe('state tools', () => {
  it('registers with Central, read at R0 and update at R1', () => {
    expect(STATE_DEFS.map((d) => [d.name, d.tier])).toEqual([['state.read', 'R0'], ['state.update', 'R1']])
    expect(registerCa2Tools(createRegistry(), {}, { WEBTERM_CENTRAL: 'on' })).toEqual(expect.arrayContaining(['state.read', 'state.update']))
  })

  it('round-trips with compare-and-swap in the global chat', async () => {
    const c = ctx(GLOBAL)
    expect((await execTool(c, 'state.read', {})).data).toMatchObject({ scope: 'global', version: 0, body: '' })
    expect((await execTool(c, 'state.update', { body: 'in flight: x', expectedVersion: 0 })).data).toEqual({ scope: 'global', version: 1 })
    expect(await execTool(c, 'state.update', { body: 'stale', expectedVersion: 0 })).toMatchObject({ ok: false, code: 'version_conflict' })
    expect((await execTool(c, 'state.read', {})).data).toMatchObject({ version: 1, body: 'in flight: x', updatedBy: 'central' })
  })

  it('a project chat is bound to its project; the global chat may name one', async () => {
    expect((await execTool(ctx(PROJECT), 'state.update', { body: 'p', expectedVersion: 0 })).data).toEqual({ scope: 'project:p1', version: 1 })
    expect(await execTool(ctx(PROJECT), 'state.update', { projectId: 'p2', body: 'x', expectedVersion: 0 })).toMatchObject({ ok: false, code: 'conversation_project_mismatch' })
    expect((await execTool(ctx(GLOBAL), 'state.read', { projectId: 'p1' })).data).toMatchObject({ scope: 'project:p1', body: 'p' })
    expect(await execTool(ctx(GLOBAL), 'state.read', { projectId: 'ghost' })).toMatchObject({ ok: false, code: 'project_not_found' })
  })

  it('reports the size limit and rejects bad shapes', async () => {
    const c = ctx(GLOBAL)
    const big = await execTool(c, 'state.update', { body: Array(201).fill('x').join('\n'), expectedVersion: 0 })
    expect(big).toMatchObject({ ok: false, code: 'state_too_large' })
    expect(String(big.data?.detail)).toContain('limit 200 lines')
    expect(await execTool(c, 'state.update', { body: 1, expectedVersion: 0 })).toMatchObject({ ok: false, code: 'invalid_shape' })
    expect(await execTool(c, 'state.update', { body: 'x', expectedVersion: -1 })).toMatchObject({ ok: false, code: 'invalid_shape' })
  })

  it('update needs R1', async () => {
    expect(await execTool(ctx(GLOBAL, 'R0'), 'state.update', { body: 'x', expectedVersion: 0 })).toMatchObject({ ok: false, code: 'tier_denied' })
  })
})
