// Bun-only. execTool with the REAL control guard (via toToolGuard): R2/R3 never run without approval.
import { expect, test } from 'bun:test'
import { createControlGuard, toToolGuard } from '../guard/controlGuard'
import { setLevel } from '../guard/levelStore'
import { freshDb, HUMAN, ROOT, T0 } from '../guard/controlGuard.testutil'
import { execTool } from './toolExec'
import { createRegistry } from './toolRegistry'
import type { Tier, ToolCtx, ToolDef } from './toolTypes'

const GATED = { WEBTERM_CENTRAL_AGENTS: 'propose' }

function setup(approved = false) {
  const db = freshDb()
  const guard = createControlGuard({ db, now: () => T0, env: GATED, random: () => 0 })
  const ran: string[] = []
  const registry = createRegistry()
  for (const tier of ['R0', 'R1', 'R2', 'R3'] as Tier[]) {
    const def: ToolDef = {
      name: `t.${tier.toLowerCase()}`,
      summary: tier,
      tier,
      usage: '{}',
      validate: () => null,
      handler: () => { ran.push(tier); return { ok: true } },
    }
    registry.register(def)
  }
  const ctx: ToolCtx = { db, registry, guard: toToolGuard(guard, { approved }), maxTier: 'R3', conversationId: 'central:project:p1', now: () => T0 }
  const level = (l: 'off' | 'propose' | 'act_gated') => setLevel(db, { scope: 'global', level: l, actor: l === 'off' ? ROOT : HUMAN, now: () => T0 })
  return { db, ctx, ran, level }
}
const call = (ctx: ToolCtx, tier: string) => execTool(ctx, `t.${tier}`, { projectId: 'p1' })

test('R2/R3 are refused with approval_required and never run; R0/R1 pass', async () => {
  const { ctx, ran, level } = setup()
  expect(level('act_gated').ok).toBe(true)
  expect((await call(ctx, 'r0')).ok).toBe(true)
  expect((await call(ctx, 'r1')).ok).toBe(true)
  const r2 = await call(ctx, 'r2')
  const r3 = await call(ctx, 'r3')
  expect([r2.ok, r2.code]).toEqual([false, 'approval_required'])
  expect([r3.ok, r3.code]).toEqual([false, 'approval_required'])
  expect(ran).toEqual(['R0', 'R1'])
})

test('R2/R3 run once the same call is executed after approval', async () => {
  const { ctx, ran, level } = setup(true)
  level('act_gated')
  expect((await call(ctx, 'r2')).ok).toBe(true)
  expect((await call(ctx, 'r3')).ok).toBe(true)
  expect(ran).toEqual(['R2', 'R3'])
})

test('approval does not lift the level ladder: at propose R2 is level_denied even when approved', async () => {
  const { ctx, ran, level } = setup(true)
  level('propose')
  expect((await call(ctx, 'r2')).code).toBe('level_denied')
  expect(ran).toEqual([])
})

test('halt denies even R0', async () => {
  const { ctx, ran, level } = setup(true)
  level('off')
  expect((await call(ctx, 'r0')).code).toBe('halted')
  expect(ran).toEqual([])
})
