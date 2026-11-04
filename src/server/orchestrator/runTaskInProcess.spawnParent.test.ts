// Central's task.run spawns its workers under `central` (K3 lineage, F2-h): runTaskInProcess sets
// `spawnParent` and productionRuntime hands it to the worker runtime.
import { describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ routeDeps: [] as unknown[], runtimeDeps: [] as unknown[] }))

vi.mock('../orchestratorRunApi', () => ({
  orchestratorRunRoute: async (_req: unknown, deps: unknown) => { seen.routeDeps.push(deps); return { status: 409, body: { error: 'plan_stale' } } },
}))
vi.mock('./workerRuntime', async (orig) => ({
  ...(await orig<typeof import('./workerRuntime')>()),
  createWorkerRuntime: (deps: unknown) => { seen.runtimeDeps.push(deps); return { runTask: async () => { throw new Error('not run') } } },
}))

const { runTaskInProcess } = await import('./runTaskInProcess')
const { productionRuntime } = await import('../orchestratorRunProduction')

describe('task.run worker lineage', () => {
  it('runTaskInProcess passes spawnParent central to the run route', async () => {
    const res = await runTaskInProcess({ projectId: 'p1', itemId: 'i1', expectedVersion: 1 }, { ledger: null })
    expect(res).toEqual({ ok: false, code: 'conflict', status: 409 })
    expect(seen.routeDeps[0]).toMatchObject({ spawnParent: 'central' })
  })

  it('productionRuntime forwards spawnParent to the worker runtime, and omits it otherwise', async () => {
    const sessions = { open: () => {}, input: () => {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close: () => {} }
    const compose = { root: '/tmp/r', repo: '/tmp/r', cmd: 'claude', agentId: 'claude', plan: {} as never, worktrees: {} as never }
    await productionRuntime({ ledger: null, sessions, spawnParent: 'central' }, compose)
    await productionRuntime({ ledger: null, sessions }, compose)
    expect(seen.runtimeDeps[0]).toMatchObject({ spawnParent: 'central' })
    expect(seen.runtimeDeps[1]).not.toHaveProperty('spawnParent')
  })
})
