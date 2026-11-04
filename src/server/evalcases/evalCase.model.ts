// Eval cases from user rejections (PLAN F6, idea #139). Shape copied from LangSmith "datasets from
// production traces" (docs.langchain.com/langsmith/manage-datasets-in-application): a run the user
// flagged becomes one example with `inputs` (here: context ref + input text), a reference outcome
// (here: the proposed action the user rejected, which a replay must not repeat) and metadata
// (source, who rejected, why), and only reaches the dataset after a human review step (LangSmith
// annotation queue -> "Add to dataset"; here: Promote to golden). Export is one JSON document.
import { maskPii } from '../memory/memoryPii'
import { PERSIST_LIMITS, redactValue } from '../redactSecrets'
import { maskValue } from '../central/runtime/runtimeEvents'

export type EvalCaseSource = 'approval' | 'central_plan' | 'memory_proposal' | 'rewind'
export type EvalCaseStatus = 'new' | 'promoted' | 'dismissed'

/** What the agent / Central wanted to do. `inputDigest` is the approval digest of the exact args. */
export interface ProposedAction {
  tool: string
  args?: unknown
  inputDigest?: string
  summary: string
}

export interface Rejection {
  by: string
  /** Surface/mechanism: `approval`, `memory.forget`, `checkpoint.rewound`. */
  how: string
}

export interface EvalCase {
  id: string
  source: EvalCaseSource
  sourceRef: string
  projectId: string | null
  workspaceId: string | null
  nodeId: string | null
  /** Where the input lives (`conversation:<id>`, `checkpoint:<ws>/<seq>`, `node:<id>`). */
  contextRef: string | null
  /** Scrubbed text that led to the proposal; null when there is none or it was forgotten. */
  inputText: string | null
  proposed: ProposedAction
  rejection: Rejection
  reason: string | null
  status: EvalCaseStatus
  rejectedAt: number
  createdAt: number
  updatedAt: number
}

export const REASON_MAX_CHARS = 2000
export const INPUT_MAX_CHARS = 16 * 1024

function maskPiiDeep(value: unknown): unknown {
  if (typeof value === 'string') return maskPii(value)
  if (Array.isArray(value)) return value.map(maskPiiDeep)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskPiiDeep(v)]))
}

/**
 * Privacy gate for everything stored in a case: broker secret values masked (same `maskValue` the MCP
 * args go through), credential shapes and secret-named keys redacted, then memory PII masking.
 */
export function scrubValue<T>(value: T, secrets: readonly string[]): T {
  return maskPiiDeep(redactValue(maskValue(value, secrets), PERSIST_LIMITS)) as T
}

export const scrubText = (text: string, secrets: readonly string[]): string => scrubValue(text, secrets)

/** Tool names as Central sees them (`mcp__webterm__goal_propose`) and as the registry has them (`goal.propose`) compare equal. */
export const normalizeTool = (name: string): string => name.replace(/^mcp__webterm__/, '').replace(/\./g, '_')
