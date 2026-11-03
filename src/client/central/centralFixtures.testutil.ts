// test-only: fake client and rows shared by the central panel tests.
import { vi } from 'vitest'
import type { ApprovalCard, CentralControlClient } from './centralControlTypes'

export const R2: ApprovalCard = {
  id: 'ap-r2', tool: 'agent.spawn', tier: 'R2', summary: 'Spawn opencode worker in project webterm',
  args: [{ key: 'kind', value: 'opencode' }, { key: 'cwd', value: '/work/webterm' }],
  digest: 'dg-1', nonce: 'nc-1', expiresAt: 0, projectId: 'webterm',
}
export const R3: ApprovalCard = { ...R2, id: 'ap-r3', tool: 'project.merge', tier: 'R3', summary: 'Merge worktree feature/x into main', digest: 'dg-3', nonce: 'nc-3' }

export function fakeClient(over: Partial<CentralControlClient> = {}): CentralControlClient {
  return {
    getControl: vi.fn(async () => ({ ceiling: 'act_gated' as const, effective: 'propose' as const, global: { level: 'propose' as const, version: 3, reason: null } })),
    getStatus: vi.fn(async () => ({ budget: { day: '2026-11-03', used: { tokens: 250, spawns: 2 }, limits: { tokens: 1000, spawns: 20 } }, model: { id: 'opencode/free', free: true } })),
    halt: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => [{ id: 'ag1', projectId: 'webterm', kind: 'opencode', role: 'worker' as const, runner: 'exec' as const, state: 'working' as const, owner: 'central:c1' as const }]),
    agentAction: vi.fn(async () => ({ status: 'done' as const })),
    listApprovals: vi.fn(async () => [R2, R3]),
    decide: vi.fn(async () => undefined),
    listSkills: vi.fn(async () => [{
      record: { name: 'webterm-x', version: '1', sha256: null, status: 'pending_approval' as const, origin: 'central' as const, caps: [], createdAt: 1, proposedBy: 'c', approvedBy: null, approvedAt: null, evalScore: 0.9 },
      lint: { ok: true, findings: [] }, diff: '+added line\n-removed line\n context',
    }]),
    approveSkill: vi.fn(async () => undefined),
    rollbackSkill: vi.fn(async () => undefined),
    listMemory: vi.fn(async () => [
      { id: 'm1', scope: 'project' as const, trust: 'human' as const, kind: 'fact' as const, key: 'stack', value: 'bun + react' },
      { id: 'm2', scope: 'user' as const, trust: 'agent' as const, kind: 'fact' as const, key: 'note', value: 'api_key=sk_live_abcdefghijklmnop1234' },
    ]),
    ...over,
  }
}
