// `/api/policy/classifier` (GET/PUT the F4-d switch) and `/api/policy/simulate` (POST a dry-run). UI-only like
// the grants routes (K4): turning the classifier on, or probing rules, is a policy change an agent never makes.
import type { IncomingMessage } from 'node:http'
import type { Database } from 'bun:sqlite'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import type { AppendEventInput } from '../events/eventModel'
import { classifierSwitch, setClassifierSwitch } from './policy.classifier'
import type { Policy } from './policy.decide'
import { simulatePolicy, type SimProposal } from './policy.simulate'

export const POLICY_CLASSIFIER_PATH = '/api/policy/classifier'
export const POLICY_SIMULATE_PATH = '/api/policy/simulate'
const RULES_MAX = 50

export interface PolicySimDeps {
  db: Database
  policy: Policy
  /** Throws on failure, so a switch that was not persisted is never reported as on. */
  append: (e: AppendEventInput) => void
  isNodeToken: (token: string) => boolean
  now: () => number
}

type Result = { status: number; body: unknown }

export const isPolicySimPath = (p: string): boolean => p === POLICY_CLASSIFIER_PATH || p === POLICY_SIMULATE_PATH

/** Handles both routes; the caller already matched the path with `isPolicySimPath`. */
export function handlePolicySimApi(req: IncomingMessage, url: URL, body: unknown, deps: PolicySimDeps): Result {
  const denial = uiOnlyDenial(req, url, deps.isNodeToken)
  if (denial) return { status: 403, body: { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_grant' : denial } }
  const method = req.method ?? 'GET'
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (url.pathname === POLICY_CLASSIFIER_PATH) {
    if (method === 'GET') return { status: 200, body: classifierSwitch(deps.db) }
    if (method !== 'PUT') return { status: 405, body: { error: 'method_not_allowed' } }
    if (typeof b.central !== 'boolean' || typeof b.permissions !== 'boolean') return { status: 400, body: { error: 'invalid_switch' } }
    return { status: 200, body: setClassifierSwitch(deps.db, deps.append, { central: b.central, permissions: b.permissions }) }
  }
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  const add = Array.isArray(b.add) ? b.add : []
  const remove = Array.isArray(b.remove) ? b.remove.filter((x): x is string => typeof x === 'string') : []
  if (add.length > RULES_MAX || remove.length > RULES_MAX) return { status: 400, body: { error: 'too_many_rules' } }
  const proposal: SimProposal = { add: add as SimProposal['add'], remove, ...(typeof b.classifier === 'boolean' ? { classifier: b.classifier } : {}) }
  const sw = classifierSwitch(deps.db)
  try {
    return { status: 200, body: simulatePolicy(deps.db, deps.policy.store.grants(), proposal, { now: deps.now(), classifierOn: sw.central || sw.permissions }) }
  } catch (err) {
    if (err instanceof RangeError) return { status: 400, body: { error: 'invalid_rule', detail: err.message } }
    throw new Error(`policy simulate failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}
