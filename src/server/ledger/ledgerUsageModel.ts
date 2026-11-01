// Tipe + serializer run/usage/budget. Dipisah dari repository agar keduanya di bawah budget file.
import type { Row } from './ledgerModel'
import { LedgerError } from './ledgerModel'
import { parseJson } from './ledgerCore'

export interface Run {
  id: string
  projectId: string
  taskId: string | null
  agentId: string | null
  depth: number
  provider: string | null
  model: string | null
  route: string | null
  prefixHash: string | null
  toolsHash: string | null
  outcome: string | null
  failureLabel: string | null
  evidence: unknown
  versions: unknown
  startedAt: number
  endedAt: number | null
}

export interface StartRunInput {
  id?: string
  projectId: string
  taskId?: string
  agentId?: string
  depth: number
  provider?: string
  model?: string
  route?: string
  prefixHash?: string
  toolsHash?: string
  startedAt?: number
}

export interface FinishRunInput {
  outcome: string
  failureLabel?: string
  evidence?: unknown
  versions?: unknown
  endedAt?: number
}

export interface UsageRecord {
  id: string
  runId: string
  providerResponseId: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  costMicros: number | null
  priceKnown: boolean
  ts: number
}

export interface RecordUsageInput {
  id?: string
  runId: string
  providerResponseId?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costMicros?: number
  priceKnown?: boolean
  ts?: number
}

export interface Budget {
  id: string
  projectId: string
  scope: string
  period: string
  limitMicros: number
  spentMicros: number
  hardCap: boolean
  updatedAt: number
}

export interface BudgetCheck {
  allowed: boolean
  spentMicros: number
  limitMicros: number
  remainingMicros: number
  hardCap: boolean
}

export function toRun(r: Row): Run {
  return {
    id: String(r['id']),
    projectId: String(r['project_id']),
    taskId: r['task_id'] === null ? null : String(r['task_id']),
    agentId: r['agent_id'] === null ? null : String(r['agent_id']),
    depth: Number(r['depth']),
    provider: r['provider'] === null ? null : String(r['provider']),
    model: r['model'] === null ? null : String(r['model']),
    route: r['route'] === null ? null : String(r['route']),
    prefixHash: r['prefix_hash'] === null ? null : String(r['prefix_hash']),
    toolsHash: r['tools_hash'] === null ? null : String(r['tools_hash']),
    outcome: r['outcome'] === null ? null : String(r['outcome']),
    failureLabel: r['failure_label'] === null ? null : String(r['failure_label']),
    evidence: parseJson(r['evidence_json']),
    versions: parseJson(r['versions_json']),
    startedAt: Number(r['started_at']),
    endedAt: r['ended_at'] === null ? null : Number(r['ended_at']),
  }
}

export function toUsage(r: Row): UsageRecord {
  const num = (key: string): number | null => (r[key] === null ? null : Number(r[key]))
  return {
    id: String(r['id']),
    runId: String(r['run_id']),
    providerResponseId:
      r['provider_response_id'] === null ? null : String(r['provider_response_id']),
    inputTokens: num('input_tokens'),
    outputTokens: num('output_tokens'),
    cacheReadTokens: num('cache_read_tokens'),
    cacheWriteTokens: num('cache_write_tokens'),
    costMicros: num('cost_micros'),
    priceKnown: Number(r['price_known']) === 1,
    ts: Number(r['ts']),
  }
}

export function toBudget(r: Row): Budget {
  return {
    id: String(r['id']),
    projectId: String(r['project_id']),
    scope: String(r['scope']),
    period: String(r['period']),
    limitMicros: Number(r['limit_micros']),
    spentMicros: Number(r['spent_micros']),
    hardCap: Number(r['hard_cap']) === 1,
    updatedAt: Number(r['updated_at']),
  }
}

/** `undefined` stays NULL (unknown), never 0. */
export function optionalCount(value: number | undefined, label: string): number | null {
  if (value === undefined) return null
  if (!Number.isInteger(value) || value < 0) {
    throw new LedgerError(`${label} must be a non-negative integer, got ${value}`)
  }
  return value
}
