// Contracts of the agent executor: the injected host/deps, the spawn input and the executor surface (pure types).
import type { Database } from 'bun:sqlite'
import type { AgentRecord, AgentRole, AgentRunner, ControlGuard, Tier } from '../contracts'
import type { ToolResult } from '../tools/toolTypes'
import type { SubmitResult } from '../../agentSubmit'
import type { AgentStore } from './agentStore'
import type { spawnAgent } from '../../spawn/agentSpawn'
import type { ModelPick } from '../../models/modelLadder'
import type { Complexity } from './agentLadder'
import type { VerifyAgentCompletion } from './agentVerify'

/** What the server needs from the process/canvas layer; implemented by WS-19 wiring, faked in tests. */
export interface AgentHost {
  /** Runner for a kind: `pty` canvas node or `exec` headless. */
  runnerFor(kind: string): AgentRunner
  /** Allocates (idempotently) the worktree of the agent and returns its absolute path. */
  worktree(agent: AgentRecord): Promise<string>
  /** Server-built task prompt for a headless run (never free model text). */
  initialPrompt(agent: AgentRecord): Promise<string>
  /** Opens the canvas session under the given deterministic node id. */
  openPty(agent: AgentRecord, cwd: string, nodeId: string, pick?: ModelPick | null): Promise<void>
  /** Relaunches the PTY of a dead agent from its saved conversation (`--resume`), continuing a cut-off turn younger than `maxAgeMs`; throws on spawn refusal. */
  resumePty?(agent: AgentRecord, cwd: string, nodeId: string, maxAgeMs: number): Promise<void>
  /** Existing worktree path of the agent (never allocates); null = none. */
  worktreeOf?(agent: AgentRecord): string | null
  /** Argv array of the headless form of `kind`, or null when it has none. */
  headlessArgv(kind: string, prompt: string): readonly string[] | null
  /** Tier a spawn of `kind` is judged at (builtin R2, custom R3), or null when the kind is unknown. */
  spawnTier(kind: string): Tier | null
  /** Definition hash of a custom kind, for the approval card and audit; absent for builtins. */
  defHashOf?(kind: string): string | undefined
  /** Extra env for a headless child of `kind` (already resolved; never logged or audited). */
  execEnv?(kind: string): Record<string, string>
  /** Types and submits `text`; a failure means the prompt did not start (nothing to retry blindly). */
  send(nodeId: string, text: string): Promise<SubmitResult>
  scrollback(nodeId: string, lines: number): Promise<string[]>
  closePty(nodeId: string, force: boolean): Promise<void>
  hasSession(nodeId: string): boolean
  /** Boot sweep: puts a live PTY agent back on the canvas when no board holds its node (never duplicates). */
  ensureNode?(agent: AgentRecord, nodeId: string): void
}

export interface AgentDeps {
  db: Database
  guard: ControlGuard
  host: AgentHost
  now(): number
  /** Source env for headless children (scrubbed); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  execTimeoutMs?: number
  /** The `agent.spawn` path (F2-h) for headless runs; default = the process-wide spawner. */
  spawn?: typeof spawnAgent
  /** Mandatory completion verifier (F4-c); default = the server verifier on the agent's worktree. */
  verifyCompletion?: VerifyAgentCompletion
}

export interface SpawnInput {
  projectId: string
  kind: string
  role: AgentRole
  title: string
  taskId?: string
  reqId: string
  /** `central:<conversationId>` for a model-requested spawn. */
  owner: AgentRecord['owner']
  /** Mode `propose`: even an allowed spawn waits for a human approval card. */
  requireApproval: boolean
  /** How hard the task is (agent.spawn); picks the ladder's start tier. Absent = the routine default. */
  complexity?: Complexity
}

export interface ReconcileReport { adopted: number; failed: number; orphaned: number; closed: number }

export interface AgentExecutor {
  readonly store: AgentStore
  /** Guard verdict mapped to a failing result, or null when the action may run now. */
  gate(projectId: string, tool: string, tier: Tier, requireApproval?: boolean): Promise<ToolResult | null>
  spawn(input: SpawnInput): Promise<ToolResult>
  /** Starts an `approval_pending` agent after a human approved its card (never reachable from a tool). */
  resume(agentId: string): Promise<ToolResult>
  /** Cancels an `approval_pending` agent whose card a human rejected (resume sweep). */
  reject(agentId: string): ToolResult
  /** Cancels an `approval_pending` agent whose card nobody answered: no consent, so no new card (resume sweep). */
  expire(agentId: string): ToolResult
  /** Puts a fresh card on an `approval_pending` agent whose approval lapsed unused (resume sweep). */
  renew(agentId: string): Promise<ToolResult>
  prompt(agent: AgentRecord, text: string, mode: 'steer' | 'followup'): Promise<ToolResult>
  close(agent: AgentRecord, reason: string, force: boolean): Promise<ToolResult>
  read(agent: AgentRecord, tail: number): Promise<ToolResult>
  /** Boot sweep: adopt spawns that crashed between intent and done, orphan agents whose session is gone. */
  reconcile(): Promise<ReconcileReport>
}
