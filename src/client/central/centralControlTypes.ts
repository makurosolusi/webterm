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
  /** `costMicros`: spent today / the daily spending limit (0 = none); absent from an older server. */
  used: { tokens: number; spawns: number; costMicros?: number }
  limits: { tokens: number; spawns: number; costMicros?: number }
}

/** `GET /api/central/status`: budget plus the model in use (drives the P12 privacy label). */
export interface StatusView {
  budget: BudgetView
  model: { id: string; free: boolean }
  /** Newest Central turn; null before the first one. `at` = when it ended, or started while still active. */
  lastTurn: { at: number; status: string } | null
}

export type AgentRow = Pick<AgentRecord, 'id' | 'projectId' | 'kind' | 'role' | 'runner' | 'state' | 'owner' | 'nodeId' | 'startedAt'> & {
  projectName: string
  /** False when `nodeId` no longer exists on any board. */
  nodeOnBoard: boolean
}

/** Worker list narrowing: running only, and/or one project. */
export interface AgentFilter { live?: boolean; projectId?: string }

/** `GET /api/central/nodes` row: a Claude node the user opened on a board (not started by Central). */
export interface BoardNodeRow {
  nodeId: string
  workspaceId: string
  projectId: string
  projectName: string
  kind: string
  title: string
  live: boolean
  status: string | null
}

/** A project for the filter; `workspaceId`/`cwd` are null from an older server or a board without a folder. */
export interface BoardProject { id: string; name: string; workspaceId?: string | null; cwd?: string | null }
export interface BoardNodesPage { items: BoardNodeRow[]; projects: BoardProject[] }

export type AgentAction = 'relay' | 'close'

/** Result of an agent action: it ran, or the server turned it into an approval card. */
export type AgentActionResult = { status: 'done' } | { status: 'needs_approval'; approvalId: string }

export interface SkillReviewRow {
  record: SkillRecord & { rejectReason?: string }
  lint: { ok: boolean; findings: string[] }
  diff: string
  canRollback: boolean
}

export interface MemoryRow {
  id: string
  scope: MemoryBlockScope
  trust: MemoryTrust
  kind: MemoryKind
  key: string
  value: string
  status: string
  sourceKind: string | null
  sourceRef: string | null
  createdAt: number
  projectName: string
}

/** Narrowing of the Remembered list. */
export interface MemoryFilter { projectId?: string; status?: 'claim' | 'fact' }

/** One pinned working-state document (`central_state`). */
export interface StateDoc { body: string; version: number; updatedAt: number; updatedBy: string }

/** `GET /api/central/state`: the global document and the selected project's. */
export interface WorkingState { global: StateDoc | null; project: StateDoc | null }

/** `GET /api/central/context`: how full the conversation's context is. */
export interface ContextView {
  tokens: number | null
  window: number
  percent: number | null
  lastCompaction: { at: number; trigger: string; preTokens: number; summary: string | null } | null
}

/** `GET /api/central/turns/:id/context`: what one turn was given; `headerChars` null = not recorded. */
export interface TurnContext {
  memory: Array<{ id: string; title: string; trust: string; status: string }>
  checkpointId: string | null
  headerChars: number | null
  stateVersions: { global: number | null; project: number | null } | null
}

export type ToolGroup = 'projects' | 'workers' | 'tasks' | 'memory' | 'browser' | 'skills' | 'channels' | 'approvals' | 'other'
/** How a tool runs at the current level: on its own, after asking you, refused by the level, or switched off. */
export type ToolAccess = 'auto' | 'asks' | 'blocked' | 'off'

export interface ToolRow {
  name: string
  summary: string
  group: ToolGroup
  tier: Tier
  on: boolean
  access: ToolAccess
}

/** `GET /api/central/tools`: every tool Central has and what the current level lets it do. */
export interface ToolsView {
  level: ControlLevel
  tools: ToolRow[]
}

/** Injectable client; the module default is `centralControlApi`. */
export interface CentralControlClient {
  getControl(signal?: AbortSignal): Promise<ControlView>
  getStatus(signal?: AbortSignal): Promise<StatusView>
  halt(reason: string): Promise<void>
  listAgents(offset: number, signal?: AbortSignal, filter?: AgentFilter): Promise<AgentRow[]>
  listBoardNodes(offset: number, projectId?: string, signal?: AbortSignal): Promise<BoardNodesPage>
  agentAction(id: string, action: AgentAction, message?: string): Promise<AgentActionResult>
  listSkills(signal?: AbortSignal): Promise<SkillReviewRow[]>
  approveSkill(name: string, version: string, phrase: string): Promise<void>
  rejectSkill(name: string, version: string): Promise<void>
  rollbackSkill(name: string): Promise<void>
  listMemory(offset: number, signal?: AbortSignal, filter?: MemoryFilter): Promise<MemoryRow[]>
  confirmMemory(id: string): Promise<void>
  forgetMemory(id: string): Promise<void>
  getWorkingState(projectId: string | undefined, signal?: AbortSignal): Promise<WorkingState>
  saveWorkingState(projectId: string | null, body: string, expectedVersion: number): Promise<void>
  listTools(signal?: AbortSignal): Promise<ToolsView>
  listActiveSkills(signal?: AbortSignal): Promise<Array<{ name: string; description: string }>>
}
