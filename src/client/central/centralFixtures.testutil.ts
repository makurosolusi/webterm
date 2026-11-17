// test-only: fake client and rows shared by the central panel tests.
import { vi } from 'vitest'
import type { CentralControlClient } from './centralControlTypes'

export function fakeClient(over: Partial<CentralControlClient> = {}): CentralControlClient {
  return {
    getControl: vi.fn(async () => ({ ceiling: 'act_gated' as const, effective: 'propose' as const, global: { level: 'propose' as const, version: 3, reason: null } })),
    getStatus: vi.fn(async () => ({ budget: { day: '2026-11-03', used: { tokens: 250, spawns: 2 }, limits: { tokens: 1000, spawns: 20 } }, model: { id: 'opencode/free', free: true }, lastTurn: null })),
    halt: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => [{ id: 'ag1', projectId: 'webterm', kind: 'opencode', role: 'worker' as const, runner: 'exec' as const, state: 'working' as const, owner: 'central:c1' as const, nodeId: null, startedAt: 1, projectName: 'Webterm', nodeOnBoard: false }]),
    listBoardNodes: vi.fn(async () => ({ items: [], projects: [] })),
    agentAction: vi.fn(async () => ({ status: 'done' as const })),
    listSkills: vi.fn(async () => [{
      record: { name: 'webterm-x', version: '1', sha256: null, status: 'pending_approval' as const, origin: 'central' as const, audience: 'central' as const, caps: [], createdAt: 1, proposedBy: 'c', approvedBy: null, approvedAt: null, evalScore: 0.9 },
      lint: { ok: true, findings: [] }, diff: '+added line\n-removed line\n context', canRollback: false, description: 'Summarize project status.', body: '1. Read the portfolio.',
    }]),
    approveSkill: vi.fn(async () => undefined),
    rejectSkill: vi.fn(async () => undefined),
    rollbackSkill: vi.fn(async () => undefined),
    setSkillEnabled: vi.fn(async () => undefined),
    listMemory: vi.fn(async () => [
      { id: 'm1', scope: 'project' as const, trust: 'human' as const, kind: 'fact' as const, key: 'stack', value: 'bun + react', status: 'fact', sourceKind: 'human-edit', sourceRef: null, createdAt: 1, projectName: 'Webterm' },
      { id: 'm2', scope: 'user' as const, trust: 'agent' as const, kind: 'fact' as const, key: 'note', value: 'api_key=sk_live_abcdefghijklmnop1234', status: 'claim', sourceKind: 'central', sourceRef: 'central:global', createdAt: 1, projectName: '' },
    ]),
    confirmMemory: vi.fn(async () => undefined),
    forgetMemory: vi.fn(async () => undefined),
    getWorkingState: vi.fn(async () => ({ global: { body: 'global notes', version: 3, updatedAt: 1, updatedBy: 'central' }, project: null })),
    saveWorkingState: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ level: 'propose' as const, tools: [
      { name: 'project.list', summary: 'List your projects and their status', group: 'projects' as const, tier: 'R0' as const, on: true, access: 'auto' as const },
      { name: 'node.list', summary: 'List the nodes in a project', group: 'projects' as const, tier: 'R0' as const, on: true, access: 'auto' as const },
      { name: 'plan.propose', summary: 'Propose a plan for you to approve', group: 'tasks' as const, tier: 'R1' as const, on: true, access: 'asks' as const },
      { name: 'agent.spawn', summary: 'Start a worker', group: 'workers' as const, tier: 'R2' as const, on: true, access: 'blocked' as const },
      { name: 'browser.open', summary: 'Open a web page', group: 'browser' as const, tier: 'R1' as const, on: false, access: 'off' as const },
    ] })),
    listActiveSkills: vi.fn(async () => [{ name: 'webterm-demo', description: 'Summarize project status' }]),
    ...over,
  }
}
