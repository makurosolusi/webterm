// What one finished candidate run is worth on the comparison card: cost from Claude Code's own final
// `result` event (`total_cost_usd`, as routines and Central read it), else priced from its `usage`
// through the cost table (costPricing.ts), and the verifier verdict reduced to plain JSON.
import type { ExecOutcome } from '../central/agents/execRunner'
import { costMicros } from '../cost/costPricing'
import type { CompletionVerdict } from '../verifier/verifier.judge'
import type { CandidateVerdict } from './bakeoff.store'

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Micro-USD of a `claude -p --output-format json` result; null = unknown (never shown as free). */
export function outcomeCostMicros(last: Record<string, unknown> | null): number | null {
  if (!last) return null
  const usd = last['total_cost_usd']
  if (typeof usd === 'number' && Number.isFinite(usd)) return Math.round(usd * 1e6)
  const usage = last['usage'] as Record<string, unknown> | undefined
  const models = last['modelUsage'] && typeof last['modelUsage'] === 'object' ? Object.keys(last['modelUsage'] as object) : []
  if (!usage || models.length !== 1) return null
  const cache = (usage['cache_creation'] ?? {}) as Record<string, unknown>
  const split = cache['ephemeral_1h_input_tokens'] !== undefined || cache['ephemeral_5m_input_tokens'] !== undefined
  return costMicros(models[0], {
    input: n(usage['input_tokens']), output: n(usage['output_tokens']), cacheRead: n(usage['cache_read_input_tokens']),
    write5m: split ? n(cache['ephemeral_5m_input_tokens']) : n(usage['cache_creation_input_tokens']),
    write1h: split ? n(cache['ephemeral_1h_input_tokens']) : 0,
  })
}

/** The agent exited 0 and Claude Code did not report an error result. */
export function outcomeOk(o: ExecOutcome): boolean {
  return o.exitCode === 0 && !o.timedOut && o.lastEvent?.['is_error'] !== true
}

export function outcomeError(o: ExecOutcome): string | null {
  if (outcomeOk(o)) return null
  if (o.error) return `agent could not start: ${o.error}`
  if (o.timedOut) return 'agent timed out'
  if (o.lastEvent?.['is_error'] === true) return `agent reported an error (${String(o.lastEvent['subtype'] ?? 'error')})`
  return `agent exited ${o.exitCode ?? 'by signal'}`
}

/** The agent's final text (for the verifier's "claim", recorded by length only). */
export const outcomeText = (o: ExecOutcome): string => (typeof o.lastEvent?.['result'] === 'string' ? (o.lastEvent['result'] as string) : o.tail)

export function toCandidateVerdict(v: CompletionVerdict): CandidateVerdict {
  const ev = v.receipt.evidence as { diffStat?: string; tests?: { passed: number; failed: number }; typecheck?: { ok: boolean } }
  return {
    status: v.status, reason: v.reason, summary: v.summary, filesChanged: v.filesChanged.length, files: v.filesChanged.slice(0, 50),
    diffStat: ev.diffStat ?? '', tests: ev.tests ? { passed: ev.tests.passed, failed: ev.tests.failed } : null,
    typecheck: ev.typecheck ? ev.typecheck.ok : null,
  }
}
