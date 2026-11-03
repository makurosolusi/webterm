// Wire shapes of the central control surface. Field names follow the frozen contracts; the
// server owns every value, the client only displays and echoes what it was given.
import type { AgentRecord } from '../../server/central/contracts/agent.types'
import type { ControlLevel, Tier } from '../../server/central/contracts/level.types'
import type { MemoryBlockScope, MemoryKind, MemoryTrust } from '../../server/central/contracts/memory.types'
import type { SkillRecord } from '../../server/central/contracts/skill.types'

/** `GET /api/central/control` (global part). */
export interface ControlView {
  ceiling: ControlLevel
  global: { level: ControlLevel; version: number; reason: string | null }
  effective: ControlLevel
}

/** Daily counters and limits; a limit of 0 means unlimited for tokens, none allowed for spawns. */
export interface BudgetView {
  day: string
  used: { tokens: number; spawns: number }
  limits: { tokens: number; spawns: number }
}

/** `GET /api/central/status`: budget plus the model in use (drives the P12 privacy label). */
export interface StatusView {
  budget: BudgetView
  model: { id: string; free: boolean }
}

export type AgentRow = Pick<AgentRecord, 'id' | 'projectId' | 'kind' | 'role' | 'runner' | 'state' | 'owner'>

export type AgentAction = 'relay' | 'close'

/** Result of an agent action: it ran, or the server turned it into an approval card. */
export type AgentActionResult = { status: 'done' } | { status: 'needs_approval'; approvalId: string }

/** One pending approval. `summary` and `args` are produced by the server from the real call. */
export interface ApprovalCard {
  id: string
  tool: string
  tier: Tier
  summary: string
  args: { key: string; value: string }[]
  digest: string
  nonce: string
  expiresAt: number
  projectId: string
  /** Server-chosen phrase for R3; the client falls back to its default. */
  confirmPhrase?: string
}

export interface SkillReviewRow {
  record: SkillRecord
  lint: { ok: boolean; findings: string[] }
  diff: string
}

export interface MemoryRow {
  id: string
  scope: MemoryBlockScope
  trust: MemoryTrust
  kind: MemoryKind
  key: string
  value: string
}

/** Injectable client; the module default is `centralControlApi`. */
export interface CentralControlClient {
  getControl(signal?: AbortSignal): Promise<ControlView>
  getStatus(signal?: AbortSignal): Promise<StatusView>
  halt(reason: string): Promise<void>
  listAgents(offset: number, signal?: AbortSignal): Promise<AgentRow[]>
  agentAction(id: string, action: AgentAction, message?: string): Promise<AgentActionResult>
  listApprovals(signal?: AbortSignal): Promise<ApprovalCard[]>
  decide(card: ApprovalCard, approve: boolean): Promise<void>
  listSkills(signal?: AbortSignal): Promise<SkillReviewRow[]>
  approveSkill(name: string, version: string): Promise<void>
  rollbackSkill(name: string): Promise<void>
  listMemory(offset: number, signal?: AbortSignal): Promise<MemoryRow[]>
}
