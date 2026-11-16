// Who a work event is attributed to, and who may close a task as done.
import type { WorkActor } from './workModel'

/** Ledger actor string of a work actor (`system:<rule>` when a rule drove it). */
export function actorName(actor: WorkActor, rule?: string): string {
  if (actor.kind === 'central') return 'central'
  if (actor.kind === 'human') return `human:${actor.id ?? 'ui'}`
  if (actor.kind === 'agent') return `agent:${actor.id}`
  return rule ? `system:${rule}` : 'system'
}

/** Only a human, or the auto-done system rule, may mark a task done. */
export function mayMarkDone(actor: WorkActor): boolean {
  return actor.kind === 'human' || (actor.kind === 'system' && actor.autoDone === true)
}
