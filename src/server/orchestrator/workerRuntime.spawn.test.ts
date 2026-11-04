// The orchestrator worker door goes through `agent.spawn` (F2-h). Minimal fakes; the full runtime
// matrix lives in workerRuntime.test.ts.
import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '../../shared/workspace'
import { createAgentSpawner, type AgentSpawnerOptions } from '../spawn/agentSpawn'
import { PROJECT, REPO, item, planOf, setup } from './orchestrator.fake.testutil'
import { SERVER_VERIFIED_BY } from './orchestratorModel'
import { createWorkerRuntime, type WorkerSessionPort } from './workerRuntime'

// test-only fakes
function run(spawnOpts: AgentSpawnerOptions, spawnParent: string) {
  const fixture = setup(planOf([item()]))
  expect(fixture.orchestrator.assignTask({ projectId: PROJECT, itemId: 'i1', assignee: 'w1', expectedVersion: 1 }).ok).toBe(true)
  const opened: { nodeId: string; cwd: string }[] = []
  const status = new Map<string, AgentStatus>()
  const live = new Set<string>()
  const sessions: WorkerSessionPort = {
    open: (i) => { opened.push(i); live.add(i.nodeId) },
    input: (n) => { status.set(n, 'done') },
    statusOf: (n) => status.get(n),
    getTerminal: () => '',
    isLive: (n) => live.has(n),
    close: (n) => { live.delete(n) },
  }
  let at = 1000
  const spawner = createAgentSpawner({ ancestors: () => [], registerSpawn: () => {}, record: () => {}, onPtyExit: () => {}, ...spawnOpts })
  const runtime = createWorkerRuntime({
    orchestrator: fixture.orchestrator, sessions, worktrees: fixture.worktrees, cmd: 'agent-cmd', agentId: 'claude',
    now: () => at, sleep: async (ms) => { at += ms }, pollMs: 100, timeoutMs: 10_000, spawn: spawner.spawn, spawnParent,
    verify: async () => ({ verifiedBy: SERVER_VERIFIED_BY, ok: true, reasons: [], evidence: [{ command: 'npm test', exitCode: 0, durationMs: 1, outputDigest: 'a'.repeat(64), summary: 'exit 0' }], changedFiles: ['src/api.ts'], scopeViolations: [], tests: { passed: 1, failed: 0, command: 'npm test' }, typecheck: { ok: true, command: 'tsc' } }),
  })
  return { outcome: runtime.runTask({ projectId: PROJECT, itemId: 'i1', expectedVersion: 2, repo: REPO, timeoutMs: 10_000 }), opened }
}

describe('orchestrator door routes through agent.spawn', () => {
  it('opens the worker via the spawner (door orchestrator, lineage under its parent, one event)', async () => {
    const lineage: [string, string][] = []
    const records: { kind: string; payload: unknown }[] = []
    const r = run({ registerSpawn: (p, c) => { lineage.push([p, c]) }, record: (e) => { records.push({ kind: e.kind, payload: e.payload }) } }, 'central')
    const outcome = await r.outcome
    expect(outcome.ok).toBe(true)
    expect(r.opened[0]).toMatchObject({ cwd: '/tmp/wt/t1' })
    expect(lineage).toEqual([['central', `node:${outcome.nodeId}`]])
    expect(records).toEqual([{ kind: 'agent.spawn', payload: expect.objectContaining({ door: 'orchestrator', mode: 'pty', kind: 'claude', depth: 1 }) }])
  })

  it('a refused spawn (depth) fails the run as spawn_failed without opening a session', async () => {
    const r = run({ ancestors: () => ['node:a', 'central'] }, 'node:b')
    const outcome = await r.outcome
    expect(outcome.error?.code).toBe('spawn_failed')
    expect(outcome.error?.message).toContain('spawn_depth_exceeded')
    expect(r.opened).toEqual([])
  })
})
