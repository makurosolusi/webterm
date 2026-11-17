// Owner decision 2026-11-17: Central is free except for writing code (workers do that). Under the default Bypass
// level no registered tool shows an approval card, and no registered tool writes project code itself.
import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../../../../shared/settings'
import { skipApprovalsFor } from '../../../../shared/settings.projectApprovalLevels'
import { createControlGuard, toToolGuard } from '../../guard/controlGuard'
import { setLevel } from '../../guard/levelStore'
import { freshDb, HUMAN, T0 } from '../../guard/controlGuard.testutil'
import { registerCa2Tools } from '../registerAll'
import { createRegistry } from '../toolRegistry'
import { CORE_DEFS } from './core.defs'

const stub = {} as never // test-only: builders capture deps, they never call them at registration
const env = new Proxy({} as Record<string, string>, { get: (_t, k: string) => (k === 'WEBTERM_CENTRAL_AGENTS' ? 'auto' : 'on') })

function everyTool() {
  const registry = createRegistry()
  for (const def of CORE_DEFS) registry.register(def)
  registerCa2Tools(registry, { executor: stub, deliver: stub, openKb: stub, skills: stub, userStore: stub, bots: stub, browser: stub }, env)
  return registry.list()
}

/** A tool that writes project files or history itself would be a code writer; Central delegates that to a worker. */
const CODE_WRITER = /^(file|fs|code|git|patch|shell|bash|exec)[._]|(^|[._])(write_file|edit_file|apply_patch|commit|push)([._]|$)/

test('no registered Central tool writes project code (a worker does, via agent.spawn / task.assign)', () => {
  const tools = everyTool()
  expect(tools.length).toBeGreaterThan(40)
  expect(tools.map((d) => d.name).filter((n) => CODE_WRITER.test(n))).toEqual([])
  // The delegation path stays: spawning and assigning workers is a normal Central tool.
  const names = tools.map((d) => d.name)
  expect(names).toEqual(expect.arrayContaining(['agent.spawn', 'task.assign']))
})

function guardFor(skip: boolean) {
  const db = freshDb()
  const guard = createControlGuard({ db, now: () => T0, env: { WEBTERM_CENTRAL_AGENTS: 'auto' }, random: () => 0, skipApprovals: () => skip })
  expect(setLevel(db, { scope: 'global', level: 'act_envelope', actor: HUMAN, now: () => T0 }).ok).toBe(true)
  return toToolGuard(guard)
}

test('default settings skip approvals; then every registered tool, R0 to R3, runs without an approval card', () => {
  expect(skipApprovalsFor(DEFAULT_SETTINGS, 'w1')).toBe(true)
  const guard = guardFor(skipApprovalsFor(DEFAULT_SETTINGS, 'w1'))
  const asked = everyTool().filter((d) => !guard.check({ tool: d.name, tier: d.tier, projectId: 'p1', input: {} }).ok).map((d) => d.name)
  expect(asked).toEqual([])
})

test('control: with approvals on (Ask/Auto) the same tools do ask, so the test above is not vacuous', () => {
  const guard = guardFor(false)
  const asked = everyTool().filter((d) => {
    const v = guard.check({ tool: d.name, tier: d.tier, projectId: 'p1', input: {} })
    return !v.ok && v.code === 'approval_required'
  })
  expect(asked.length).toBeGreaterThan(0)
})
