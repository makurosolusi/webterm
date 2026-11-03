import { describe, expect, it, vi } from 'vitest'
import {
  autonomyEnabled,
  createCentralAutonomy,
  type AutonomyAuditEvent,
  type AutonomyDeps,
  type AutonomyPlan,
  type AutonomyPlanItem,
  type AutonomyProject,
} from './centralAutonomy'

function item(seq: number, status: string, id = `i${seq}`): AutonomyPlanItem {
  return { id, seq, status }
}

function plan(status: string, items: AutonomyPlanItem[], version = 7): AutonomyPlan {
  return { status, version, items }
}

interface RunCall {
  projectId: string
  itemId: string
  expectedVersion: number
}

function harness(overrides: Partial<AutonomyDeps> = {}): {
  deps: AutonomyDeps
  projects: AutonomyProject[]
  plans: Map<string, AutonomyPlan | null>
  runs: RunCall[]
  audits: AutonomyAuditEvent[]
} {
  const projects: AutonomyProject[] = [{ id: 'p1', status: 'active' }]
  const plans = new Map<string, AutonomyPlan | null>()
  const runs: RunCall[] = []
  const audits: AutonomyAuditEvent[] = []
  const deps: AutonomyDeps = {
    projects: () => projects,
    plan: (projectId) => plans.get(projectId) ?? null,
    run: async (projectId, itemId, expectedVersion) => {
      runs.push({ projectId, itemId, expectedVersion })
      return { ok: true }
    },
    audit: (event) => audits.push(event),
    now: () => 1_000,
    ...overrides,
  }
  return { deps, projects, plans, runs, audits }
}

describe('central autonomy tick', () => {
  it('skips a paused project', async () => {
    const h = harness()
    h.projects[0] = { id: 'p1', status: 'paused' }
    h.plans.set('p1', plan('active', [item(1, 'assigned')]))
    const autonomy = createCentralAutonomy(h.deps)

    await expect(autonomy.tick()).resolves.toEqual({ ran: false, reason: 'no_eligible' })
    expect(h.runs).toEqual([])
  })

  it('skips plans that are completed or abandoned', async () => {
    const h = harness()
    h.projects.push({ id: 'p2', status: 'active' })
    h.plans.set('p1', plan('completed', [item(1, 'assigned')]))
    h.plans.set('p2', plan('abandoned', [item(1, 'assigned')]))
    const autonomy = createCentralAutonomy(h.deps)

    await expect(autonomy.tick()).resolves.toEqual({ ran: false, reason: 'no_eligible' })
    expect(h.runs).toEqual([])
  })

  it('picks the lowest-seq assigned item and passes the plan version', async () => {
    const h = harness()
    h.plans.set('p1', plan('active', [item(9, 'assigned'), item(2, 'pending'), item(3, 'assigned')], 4))
    const autonomy = createCentralAutonomy(h.deps)

    await expect(autonomy.tick()).resolves.toEqual({
      ran: true,
      projectId: 'p1',
      itemId: 'i3',
      ok: true,
    })
    expect(h.runs).toEqual([{ projectId: 'p1', itemId: 'i3', expectedVersion: 4 }])
  })

  it('never touches a running item', async () => {
    const h = harness()
    h.plans.set('p1', plan('active', [item(1, 'running'), item(2, 'done')]))
    const autonomy = createCentralAutonomy(h.deps)

    await expect(autonomy.tick()).resolves.toEqual({ ran: false, reason: 'no_eligible' })
    expect(h.runs).toEqual([])
  })

  it('runs exactly one item per tick across projects', async () => {
    const h = harness()
    h.projects.push({ id: 'p2', status: 'active' })
    h.plans.set('p1', plan('active', [item(1, 'assigned')]))
    h.plans.set('p2', plan('active', [item(1, 'assigned')]))
    const autonomy = createCentralAutonomy(h.deps)

    await autonomy.tick()
    expect(h.runs).toHaveLength(1)
    // The real route flips the item to `running`; model that so the next tick moves on.
    h.plans.set('p1', plan('active', [item(1, 'running')]))
    await autonomy.tick()
    expect(h.runs).toHaveLength(2)
    expect(h.runs.map((r) => r.projectId)).toEqual(['p1', 'p2'])
  })

  it('quarantines a project after 3 consecutive failures', async () => {
    const h = harness({
      run: async () => ({ ok: false, code: 'not_assigned' }),
    })
    h.plans.set('p1', plan('active', [item(1, 'assigned')]))
    const autonomy = createCentralAutonomy(h.deps)

    for (let i = 0; i < 3; i += 1) expect((await autonomy.tick()).ran).toBe(true)
    expect(autonomy.failures('p1')).toBe(3)
    await expect(autonomy.tick()).resolves.toEqual({ ran: false, reason: 'no_eligible' })
    expect(h.audits.filter((a) => a.kind === 'autonomy.budget_exhausted')).toHaveLength(1)
  })

  it('resets the failure budget on success', async () => {
    let fail = true
    const h = harness({
      run: async () => (fail ? { ok: false, code: 'boom' } : { ok: true }),
    })
    h.plans.set('p1', plan('active', [item(1, 'assigned')]))
    const autonomy = createCentralAutonomy(h.deps)

    await autonomy.tick()
    await autonomy.tick()
    expect(autonomy.failures('p1')).toBe(2)
    fail = false
    await autonomy.tick()
    expect(autonomy.failures('p1')).toBe(0)
    fail = true
    await autonomy.tick()
    expect(autonomy.failures('p1')).toBe(1)
  })

  it('re-arms a quarantined project when its status changes', async () => {
    const h = harness({ run: async () => ({ ok: false, code: 'boom' }) })
    h.plans.set('p1', plan('active', [item(1, 'assigned')]))
    const autonomy = createCentralAutonomy(h.deps)

    for (let i = 0; i < 3; i += 1) await autonomy.tick()
    expect((await autonomy.tick()).ran).toBe(false)
    h.projects[0] = { id: 'p1', status: 'paused' }
    await autonomy.tick()
    h.projects[0] = { id: 'p1', status: 'active' }
    expect((await autonomy.tick()).ran).toBe(true)
  })

  it('never overlaps ticks when a run is slow', async () => {
    let release: (() => void) | null = null
    let calls = 0
    const h = harness({
      run: () => {
        calls += 1
        return new Promise((resolve) => {
          release = () => resolve({ ok: true })
        })
      },
    })
    h.plans.set('p1', plan('active', [item(1, 'assigned')]))
    const autonomy = createCentralAutonomy(h.deps)

    const first = autonomy.tick()
    await expect(autonomy.tick()).resolves.toEqual({ ran: false, reason: 'overlap' })
    expect(release).not.toBeNull()
    ;(release as unknown as () => void)()
    await expect(first).resolves.toMatchObject({ ran: true, ok: true })
    expect(calls).toBe(1)
  })

  it('treats a thrown run as a failure instead of crashing', async () => {
    const h = harness({ run: async () => Promise.reject(new Error('boom')) })
    h.plans.set('p1', plan('active', [item(1, 'assigned')]))
    const autonomy = createCentralAutonomy(h.deps)

    await expect(autonomy.tick()).resolves.toMatchObject({ ran: true, ok: false, code: 'internal' })
    expect(autonomy.failures('p1')).toBe(1)
  })

  it('start() is idempotent and stop() clears the unref timer', () => {
    const h = harness()
    const autonomy = createCentralAutonomy({ ...h.deps, intervalMs: 60_000 })
    autonomy.start()
    expect(autonomy.running).toBe(true)
    autonomy.start()
    expect(autonomy.running).toBe(true)
    autonomy.stop()
    expect(autonomy.running).toBe(false)
  })
})

describe('central autonomy flag parser', () => {
  it('reads only the literal on value', () => {
    expect(autonomyEnabled('on')).toBe(true)
    expect(autonomyEnabled(' ON ')).toBe(true)
    expect(autonomyEnabled('off')).toBe(false)
    expect(autonomyEnabled(undefined)).toBe(false)
    // objek env: autonomy butuh workers butuh central (implies)
    expect(autonomyEnabled({ WEBTERM_CENTRAL_AUTONOMY: 'on' })).toBe(false)
    expect(autonomyEnabled({ WEBTERM_CENTRAL: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on', WEBTERM_CENTRAL_AUTONOMY: 'on' })).toBe(true)
  })
})
