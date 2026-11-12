import { describe, expect, it } from 'vitest'
import type { WorkerSessionPort } from '../../orchestrator/workerRuntimeSession'
import type { WorktreeService } from '../../orchestrator/worktree'
import type { AgentRecord } from '../contracts'
import type { AgentCatalog, CatalogEntry } from './agentCatalog'
import { createAgentHost } from './agentHost'
import { createAgentSpawner } from '../../spawn/agentSpawn'

// test-only fakes: one PTY kind, sessions that just record opens.
const entry = { kind: 'claude', builtin: true, launchLine: 'claude', headlessArgv: null, tier: 'R2', childEnv: () => ({}) } as unknown as CatalogEntry
const catalog: AgentCatalog = { resolve: (k) => (k === 'claude' ? entry : null), kinds: () => [] }
const agent = (owner: AgentRecord['owner']) => ({ id: 'a1', projectId: 'p1', kind: 'claude', role: 'worker', owner } as unknown as AgentRecord)

function host(task?: { title: string; objective: string }) {
  const opened: string[] = []
  const spawns: [string, string][] = []
  const events: { kind: string; payload: unknown }[] = []
  const sessions = { open: (i: { nodeId: string }) => { opened.push(i.nodeId) } } as unknown as WorkerSessionPort
  const spawner = createAgentSpawner({ ancestors: () => [], registerSpawn: (parent, child) => { spawns.push([parent, child]) }, record: (e) => { events.push({ kind: e.kind, payload: e.payload }) }, onPtyExit: () => {} })
  const h = createAgentHost({ sessions, worktrees: {} as WorktreeService, repoOf: () => null, catalog, spawn: spawner.spawn, ...(task ? { task: () => task } : {}) })
  return { h, opened, spawns, events }
}

describe('createAgentHost policy lineage (K3)', () => {
  it('registers the spawned PTY node under its spawner after the session opens', async () => {
    const { h, opened, spawns } = host()
    await h.openPty(agent('central:p1'), '/wt', 'n1')
    await h.openPty(agent('human'), '/wt', 'n2')
    expect(opened).toEqual(['n1', 'n2'])
    expect(spawns).toEqual([['central', 'node:n1'], ['human-ui', 'node:n2']])
  })

  it('routes through agent.spawn: one agent.spawn event per open, door central, depth 1', async () => {
    const { h, events } = host()
    await h.openPty(agent('central:p1'), '/wt', 'n1')
    expect(events).toEqual([{ kind: 'agent.spawn', payload: { kind: 'claude', mode: 'pty', door: 'central', depth: 1, name: 'worker claude' } }])
  })

  it('an unknown kind opens nothing and registers nothing', async () => {
    const { h, spawns } = host()
    await expect(h.openPty({ ...agent('central:p1'), kind: 'nope' } as AgentRecord, '/wt', 'n3')).rejects.toThrow(/nope/)
    expect(spawns).toEqual([])
  })
})

describe('boot prompt: the first message carries the whole task', () => {
  const objective = 'Objective: compare bun and node\n\nOutput format: End with a line `RESULT:` followed by markdown'
  it('with a task: role, ids, title, objective and how the result reaches Central; never "No task attached"', async () => {
    const { h } = host({ title: 'web research: compare bun and node', objective })
    const text = await h.initialPrompt({ ...agent('central:c1'), taskId: 'tk-9' } as AgentRecord)
    expect(text).toContain('You are a worker agent started by webterm Central (agent a1, canvas node c-a1, project p1).')
    expect(text).toContain('Task tk-9: web research: compare bun and node.')
    expect(text).toContain(objective)
    expect(text).toContain('webterm reports it to Central automatically')
    expect(text).not.toContain('No task attached')
  })

  it('a task id whose row is gone still names the task, not "no task"', async () => {
    const h = createAgentHost({ sessions: {} as WorkerSessionPort, worktrees: {} as WorktreeService, repoOf: () => null, catalog, task: () => null })
    const text = await h.initialPrompt({ ...agent('central:c1'), taskId: 'tk-9' } as AgentRecord)
    expect(text).toContain('Task tk-9.')
    expect(text).not.toContain('No task attached')
  })

  it('without a task the agent waits instead of finishing a turn of its own', async () => {
    const { h } = host()
    expect(await h.initialPrompt({ ...agent('central:c1'), taskId: null } as AgentRecord)).toContain('reply only READY and wait')
  })
})
