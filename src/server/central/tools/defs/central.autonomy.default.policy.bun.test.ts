// Owner decision 2026-11-17 (control ladder): with nothing configured (no row, env unset) Central is at the top
// level, so no registered tool is level_denied and none below R3 asks. The fences stay whatever the default is.
import { expect, test } from 'bun:test'
import { createControlGuard, toToolGuard } from '../../guard/controlGuard'
import { setLevel } from '../../guard/levelStore'
import { freshDb, HUMAN, T0 } from '../../guard/controlGuard.testutil'
import { registerCa2Tools } from '../registerAll'
import { createRegistry } from '../toolRegistry'
import { CORE_DEFS } from './core.defs'

const stub = {} as never // test-only: builders capture deps, they never call them at registration
const allOn = new Proxy({} as Record<string, string>, { get: (_t, k: string) => (k === 'WEBTERM_CENTRAL_AGENTS' ? 'auto' : 'on') })

function everyTool() {
  const registry = createRegistry()
  for (const def of CORE_DEFS) registry.register(def)
  registerCa2Tools(registry, { executor: stub, deliver: stub, openKb: stub, skills: stub, userStore: stub, bots: stub, browser: stub }, allOn)
  return registry.list()
}

function defaultGuard(env: Record<string, string> = {}) {
  const db = freshDb()
  const guard = toToolGuard(createControlGuard({ db, now: () => T0, env, random: () => 0 }))
  const check = (name: string, tier: string) => guard.check({ tool: name, tier: tier as never, projectId: 'p1', input: {} })
  return { db, check }
}

test('default (no row, env unset): agent.spawn, agent.prompt and canvas.* run with no level_denied and no card', () => {
  const { check } = defaultGuard()
  const tools = everyTool()
  const wanted = tools.filter((d) => d.name === 'agent.spawn' || d.name === 'agent.prompt' || d.name.startsWith('canvas.'))
  expect(wanted.length).toBeGreaterThan(3)
  for (const d of wanted) expect([d.name, check(d.name, d.tier)]).toEqual([d.name, { ok: true }])
  const denied = tools.filter((d) => { const v = check(d.name, d.tier); return !v.ok && v.code === 'level_denied' })
  expect(denied.map((d) => d.name)).toEqual([])
})

test('control: an explicit owner choice still narrows it (off = level_denied, propose = a card)', () => {
  expect(defaultGuard({ WEBTERM_CENTRAL_AGENTS: 'off' }).check('agent.spawn', 'R2')).toMatchObject({ ok: false, code: 'level_denied' })
  expect(defaultGuard({ WEBTERM_CENTRAL_AGENTS: 'propose' }).check('agent.spawn', 'R2')).toMatchObject({ ok: false, code: 'approval_required' })
})

test('fences stay at the default: the daily spawn cap denies, halt denies', () => {
  const capped = defaultGuard({ WEBTERM_CENTRAL_DAILY_SPAWNS: '0' })
  expect(capped.check('agent.spawn', 'R2')).toMatchObject({ ok: false, code: 'spawn_daily' })
  const halted = defaultGuard()
  expect(setLevel(halted.db, { scope: 'global', level: 'off', actor: HUMAN, now: () => T0 }).ok).toBe(true)
  expect(halted.check('task.assign', 'R2')).toMatchObject({ ok: false, code: 'halted' })
})
