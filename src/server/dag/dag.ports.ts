// The scheduler's outside world (F4-b): ports the production wiring (`dag.runtime.ts`) and the tests
// fill in, and the headless Claude Code argv of one worker. Split from `dag.scheduler.ts` (file health).
import type { AppendEventInput } from '../events/eventModel'
import type { LedgerContext } from '../ledger/ledgerCore'
import type { ConfiguredCommand } from '../orchestrator/verifyCommands'
import { claudeHeadlessArgv, type AgentSpawnRequest, type AgentSpawnResult } from '../spawn/agentSpawn'
import type { BeginRunInput, GateResult } from '../cost/costOracle'
import type { CompletionVerdict } from '../verifier/verifier.judge'
import type { CompletionReport } from '../verifier/verifier.report'
import type { DagTask } from './dag.model'
import type { Dag } from './dag.store'

export interface VerifyTaskInput {
  taskId: string
  cwd: string
  lease: string[]
  verifyCmd: ConfiguredCommand
  baseRef: string
  timeoutMs: number
  claim?: string
}

export interface DagPorts {
  ctx: LedgerContext
  record(event: AppendEventInput): void
  /** The `workers` capability switch (Settings); off = nothing is dispatched. */
  workersEnabled(): boolean
  /** Commits the dag base is behind its base branch; null = unknown (guard inert, Orca `:76`). */
  behind(dag: Dag): Promise<number | null>
  /** Fresh worktree for one dispatch, created from the dag base. */
  allocate(dag: Dag, task: DagTask, dispatchId: string): Promise<{ path: string; branch: string; baseSha: string }>
  spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult>
  verify(input: VerifyTaskInput): Promise<CompletionVerdict>
  report(report: CompletionReport): void
  /** Opens the inbox gate card (ledger approval); returns the approval id. */
  openGate(input: { projectId: string; title: string; body: string; options: string[] | null; nodeId: string | null }): string
  /** Cost oracle (costRuntime), scope `dag:<id>`: gate before each dispatch, a cost window per worker. Absent = no gate. */
  cost?: {
    gate(q: { kind: 'dag'; ref: string }): Promise<GateResult>
    begin(input: BeginRunInput): Promise<string | null>
    end(id: string | null, outcome: { producedDiff?: boolean }): Promise<unknown>
  }
}

/**
 * Headless Claude Code argv for one worker. `--tools` limits the built-in tools Claude can use at all;
 * `--allowedTools` only pre-approves calls (it does NOT restrict, per code.claude.com/docs/en/cli-reference),
 * so both are needed. `--tools` takes bare names, so `Bash(git *)` contributes `Bash` there and stays a
 * scoped rule in `--allowedTools`.
 */
export function dagWorkerArgv(prompt: string, tools: string[]): string[] {
  const names = [...new Set(tools.map((t) => t.replace(/\(.*$/s, '').trim()).filter(Boolean))]
  return [...claudeHeadlessArgv(prompt), '--tools', names.join(','), ...(tools.length ? ['--allowedTools', tools.join(',')] : [])]
}
