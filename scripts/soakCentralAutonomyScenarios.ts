// Bounded invariant scenarios for scripts/soakCentralAutonomy.ts.
// The soak cannot reach a 3-failure streak with `--fail-every 17`, so quarantine and budget reset
// are proven here on their own tiny instances of the real scheduler.
import {
  createCentralAutonomy,
  type AutonomyAuditEvent,
  type AutonomyPlan,
  type AutonomyPlanItem,
  type AutonomyProject,
} from '../src/server/central/centralAutonomy'
import { invariant } from './soakCentralAutonomyModel'

export interface ScenarioResult {
  name: string
  ok: boolean
  detail: string
}

function plainPlan(items: AutonomyPlanItem[], status = 'active'): AutonomyPlan {
  return { status, version: 1, items }
}

async function checkQuarantineScenario(): Promise<ScenarioResult> {
  const projects: AutonomyProject[] = [{ id: 'p1', status: 'active' }]
  const audits: AutonomyAuditEvent[] = []
  let runs = 0
  const autonomy = createCentralAutonomy({
    projects: () => projects,
    plan: () => plainPlan([{ id: 'i1', seq: 1, status: 'assigned' }]),
    run: async () => {
      runs += 1
      return { ok: false, code: 'fake_run_failed' }
    },
    audit: (event) => audits.push(event),
  })

  for (let i = 0; i < 10; i += 1) await autonomy.tick()
  invariant(runs === 3, `quarantine: expected 3 runs before quarantine, got ${runs}`)
  invariant(autonomy.failures('p1') === 3, 'quarantine: expected failures === 3')
  invariant(
    audits.filter((event) => event.kind === 'autonomy.budget_exhausted').length === 1,
    'quarantine: expected exactly one budget_exhausted audit event'
  )

  // An operator status flip is a signal: it clears the budget and the loop resumes.
  projects[0] = { id: 'p1', status: 'paused' }
  await autonomy.tick()
  projects[0] = { id: 'p1', status: 'active' }
  await autonomy.tick()
  const resumedRuns: number = runs
  invariant(resumedRuns === 4, `quarantine: expected a run after status flip, got ${resumedRuns}`)

  return {
    name: 'failure-budget quarantine after 3 + status-flip reset',
    ok: true,
    detail: '3 runs, 1 budget_exhausted audit, resumed after flip',
  }
}

async function checkSuccessResetsBudget(): Promise<ScenarioResult> {
  const projects: AutonomyProject[] = [{ id: 'p1', status: 'active' }]
  let calls = 0
  const autonomy = createCentralAutonomy({
    projects: () => projects,
    plan: () => plainPlan([{ id: 'i1', seq: 1, status: 'assigned' }]),
    run: async () => {
      calls += 1
      return calls <= 2 ? { ok: false, code: 'fake_run_failed' } : { ok: true }
    },
    audit: () => {},
  })

  await autonomy.tick()
  await autonomy.tick()
  invariant(autonomy.failures('p1') === 2, 'budget: expected 2 failures recorded')
  await autonomy.tick()
  invariant(calls === 3, `budget: expected 3 runs, got ${calls}`)
  invariant(autonomy.failures('p1') === 0, 'budget: success must reset consecutive failures')

  return {
    name: 'success resets failure budget',
    ok: true,
    detail: '2 failures then success -> failures 0',
  }
}

async function checkPausedAndTerminalSkip(): Promise<ScenarioResult> {
  const projects: AutonomyProject[] = [
    { id: 'paused', status: 'paused' },
    { id: 'done', status: 'active' },
    { id: 'abandoned', status: 'active' },
  ]
  let runs = 0
  const autonomy = createCentralAutonomy({
    projects: () => projects,
    plan: (projectId) => {
      const item = [{ id: 'i1', seq: 1, status: 'assigned' as const }]
      if (projectId === 'done') return plainPlan(item, 'completed')
      if (projectId === 'abandoned') return plainPlan(item, 'abandoned')
      return plainPlan(item)
    },
    run: async () => {
      runs += 1
      return { ok: true }
    },
    audit: () => {},
  })

  for (let i = 0; i < 5; i += 1) await autonomy.tick()
  invariant(runs === 0, `pause/terminal: expected no runs, got ${runs}`)

  return {
    name: 'paused project and terminal plans are never run',
    ok: true,
    detail: '5 ticks, 0 runs',
  }
}

export async function runScenarios(): Promise<ScenarioResult[]> {
  const runners = [checkQuarantineScenario, checkSuccessResetsBudget, checkPausedAndTerminalSkip]
  const results: ScenarioResult[] = []
  for (const runner of runners) results.push(await runner())
  return results
}
