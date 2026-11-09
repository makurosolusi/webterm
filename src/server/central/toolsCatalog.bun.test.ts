import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import { FALLBACK_TIER_MIN } from '../policy/policy.store'
import { type Ca2Handle, bootCa2, setActiveCa2 } from './ca2Boot'
import { ca2Dispatch, isCa2Path } from './ca2Routes'
import { CONTROL_LEVELS, type ControlLevel, type Tier } from './contracts/level.types'
import { ladderDecision } from './guard/controlGuard'
import { freshDb, HUMAN, T0 } from './guard/controlGuard.testutil'
import { setLevel } from './guard/levelStore'
import { type CatalogTool, TOOLS_PATH, toolAccess, toolGroupOf } from './toolsCatalog.api'
import { CORE_DEFS } from './tools/defs/core.defs'
import { createRegistry } from './tools/toolRegistry'
import type { ToolDef } from './tools/toolTypes'

const sessions = { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike
const minimum = (t: Tier): ControlLevel => FALLBACK_TIER_MIN[t]

describe('ladderDecision / toolAccess: tier x level', () => {
  // Columns follow CONTROL_LEVELS: off, observe, propose, act_gated, act_envelope.
  const table: Array<[string, Tier, string[]]> = [
    ['goal.read', 'R0', ['blocked', 'auto', 'auto', 'auto', 'auto']],
    ['goal.propose', 'R1', ['blocked', 'blocked', 'auto', 'auto', 'auto']],
    ['task.assign', 'R2', ['blocked', 'blocked', 'blocked', 'asks', 'auto']],
    ['project.bootstrap', 'R3', ['blocked', 'blocked', 'asks', 'asks', 'asks']],
    ['agent.spawn', 'R2', ['blocked', 'blocked', 'blocked', 'asks', 'auto']],
    // Spawn lift: an R1 spawn tool needs act_gated and is judged R2, unlike a plain R1 tool.
    ['task.run', 'R1', ['blocked', 'blocked', 'blocked', 'asks', 'auto']],
    ['agent.spawn', 'R3', ['blocked', 'blocked', 'blocked', 'asks', 'asks']],
  ]
  for (const [name, tier, want] of table) {
    it(`${name} ${tier}`, () => {
      expect(CONTROL_LEVELS.map((l) => toolAccess(name, tier, true, l, minimum))).toEqual(want)
    })
  }
  it('a switched-off tool is off at every level', () => {
    for (const l of CONTROL_LEVELS) expect(toolAccess('goal.propose', 'R1', false, l, minimum)).toBe('off')
  })
  it('reports the needed level and the lifted tier', () => {
    expect(ladderDecision('spawn', 'R1', 'propose', minimum)).toEqual({ verdict: 'deny', need: 'act_gated' })
    expect(ladderDecision('spawn', 'R1', 'act_gated', minimum)).toEqual({ verdict: 'needs_approval', tier: 'R2' })
    expect(ladderDecision('turn', 'R0', 'observe', minimum)).toEqual({ verdict: 'allow', tier: 'R0' })
  })
  it('follows the data-driven tier minimum', () => {
    expect(toolAccess('goal.propose', 'R1', true, 'propose', () => 'act_gated')).toBe('blocked')
  })
  it('groups by name prefix', () => {
    const cases: Array<[string, string]> = [['project.read', 'projects'], ['node.list', 'projects'], ['canvas.open', 'projects'], ['canvas.close', 'projects'], ['canvas.edit', 'projects'], ['workspace.create', 'projects'], ['agent.spawn', 'workers'], ['task.run', 'tasks'],
      ['plan.propose', 'tasks'], ['goal.propose', 'tasks'], ['run.result', 'tasks'], ['memory.get', 'memory'], ['kb.search', 'memory'],
      ['browser_act', 'browser'], ['skill.list', 'skills'], ['channel.bot.propose', 'channels'], ['central_bot', 'channels'],
      ['approval.request', 'approvals'], ['cap.search', 'other'], ['blackboard.read', 'memory'], ['repo.map', 'projects']]
    for (const [name, group] of cases) expect(toolGroupOf(name)).toBe(group)
  })
})

describe('GET /api/central/tools', () => {
  let dir: string
  let h: Ca2Handle
  // test-only stand-ins: every core def is R1, so an R2 one exercises the approval column.
  const flagged: ToolDef = { ...CORE_DEFS[0]!, name: 'memory.zz_flagged', flag: 'WEBTERM_TEST_NEVER_ON' }
  const r2: ToolDef = { ...CORE_DEFS[0]!, name: 'project.zz_r2', tier: 'R2' }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ca2-tools-'))
    const registry = createRegistry()
    for (const d of CORE_DEFS) registry.register(d)
    registry.register(flagged)
    registry.register(r2)
    const booted = bootCa2({
      runtime: { db: freshDb() } as unknown as LedgerRuntime, sessions, registry, noTimer: true, dataDirPath: dir, now: () => T0,
      env: { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_AGENTS: 'propose' },
    })
    if (!booted) throw new Error('boot failed')
    h = booted
  })
  afterEach(() => {
    h.stop()
    setActiveCa2(null)
    rmSync(dir, { recursive: true, force: true })
  })
  const get = (handle: Ca2Handle) => ca2Dispatch(handle, { method: 'GET', path: TOOLS_PATH, query: new URLSearchParams(), body: async () => ({}) })
  const level = (l: ControlLevel) => expect(setLevel(h.db, { scope: 'global', level: l, actor: HUMAN, now: () => T0 }).ok).toBe(true)

  it('lists the registry with the contract shape, sorted by group then name', async () => {
    expect(isCa2Path(TOOLS_PATH)).toBe(true)
    const res = await get(h)
    expect(res?.status).toBe(200)
    const body = res?.body as { level: ControlLevel; tools: CatalogTool[] }
    // WEBTERM_CENTRAL_AGENTS=propose caps the ceiling at act_gated.
    expect(body.level).toBe('act_gated')
    expect(body.tools.length).toBe(h.registry.list().length)
    for (const t of body.tools) expect(Object.keys(t).sort()).toEqual(['access', 'group', 'name', 'on', 'summary', 'tier'])
    const groups = body.tools.map((t) => t.group)
    expect(groups.indexOf('tasks') < groups.indexOf('approvals')).toBe(true)
    const names = body.tools.filter((t) => t.group === 'tasks').map((t) => t.name)
    expect(names).toEqual([...names].sort())
    const byName = Object.fromEntries(body.tools.map((t) => [t.name, t]))
    expect(byName['goal.propose']).toEqual({ name: 'goal.propose', summary: CORE_DEFS[0]!.summary, group: 'tasks', tier: 'R1', on: true, access: 'auto' })
    expect(byName['project.zz_r2']?.access).toBe('asks')
    expect(byName['memory.zz_flagged']).toMatchObject({ on: false, access: 'off' })
  })

  it('follows a level change', async () => {
    level('propose')
    const body = (await get(h))?.body as { level: ControlLevel; tools: CatalogTool[] }
    expect(body.level).toBe('propose')
    expect(body.tools.find((t) => t.name === 'project.zz_r2')?.access).toBe('blocked')
    expect(body.tools.find((t) => t.name === 'goal.propose')?.access).toBe('auto')
  })

  it('answers 200 when Central is halted and when its feature families are off', async () => {
    level('off')
    const halted = await get(h)
    expect(halted?.status).toBe(200)
    const body = halted?.body as { level: ControlLevel; tools: CatalogTool[] }
    expect(body.level).toBe('off')
    for (const t of body.tools) expect(t.access === 'blocked' || t.access === 'off').toBe(true)
    expect((await get({ ...h, executor: null, skills: null } as Ca2Handle))?.status).toBe(200)
  })

  it('is read-only', async () => {
    expect((await ca2Dispatch(h, { method: 'POST', path: TOOLS_PATH, query: new URLSearchParams(), body: async () => ({}) }))?.status).toBe(405)
  })
})
