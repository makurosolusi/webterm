// Policy engine (PLAN/01-arsitektur.md S2): `decide(principal, capability, args) -> allow | ask | deny`.
// Rule order (last match wins, OpenCode): builtin rows -> live cable grants -> persisted human/telegram
// rules. A node's decision is then attenuated by every ancestor (K3), a destructive capability is never
// auto-allowed by a non-human rule (S2 never-auto), and every decision is appended to the Senses log.
import type { Database } from 'bun:sqlite'
import type { Workspace } from '../../shared/workspace'
import { CONTROL_CAPABILITIES } from '../capability/control.capabilities'
import { eventBus } from '../events/eventBus'
import { createEventLog, type EventLog } from '../events/eventLog'
import { cableGrants } from './policy.cable'
import { EFFECTS, evaluate, isAgentPrincipal, principalKind, stricter, type Decision, type Effect, type Grant, type Principal } from './policy.model'
import { createPolicyStore, type PolicyStore } from './policy.store'

export const DECISION_EVENT = 'policy.decision'
export const GRANT_EVENT = 'policy.grant'
/** "Allow once" from Telegram (K4): an expiring rule, at most this long. */
export const TELEGRAM_GRANT_MAX_MS = 60 * 60_000
const MAX_PATTERN = 200
const MAX_ACTOR = 64

export interface DecideArgs {
  /** Resource acted on: `node:<id>`, `workspace:<id>`, `project:<id>`. */
  resource?: string
  /** Overrides the registry flag (for capabilities outside the control registry). */
  destructive?: boolean
  workspaceId?: string
  /**
   * Cable grants the caller already computed from the board it holds (`cableGrants`), used instead of
   * `deps.workspaces` so the decision and the target resolution read the very same board.
   */
  cable?: readonly Grant[]
}

export interface GrantInput {
  subject: string
  capability: string
  scope?: string
  effect: Effect
  /** Epoch ms; null/absent = permanent (human-ui only, K4). */
  expiresAt?: number | null
}

export type GrantResult = { ok: true; grant: Grant } | { ok: false; status: 400 | 403 | 404; code: string }

export interface PolicyDeps {
  db: Database
  now?: () => number
  /** Board source for cable grants; absent = no cable grants (callers without a board, e.g. Central). */
  workspaces?: () => readonly Workspace[]
  events?: Pick<EventLog, 'append'>
}

const DESTRUCTIVE = new Set(CONTROL_CAPABILITIES.filter((c) => c.destructive).map((c) => c.name))

const validPattern = (s: unknown): s is string => typeof s === 'string' && s !== '' && s.length <= MAX_PATTERN

export function createPolicy(deps: PolicyDeps) {
  const now = deps.now ?? Date.now
  const store: PolicyStore = createPolicyStore(deps.db, now)
  // ponytail: a private log instance skips the anchor writer's debounce; the runtime's next append
  // anchors the shared head anyway. Pass `events` (activeEventLog) to reuse the process log.
  const events = deps.events ?? createEventLog(deps.db, { now, bus: eventBus })

  const rulesFor = (principal: Principal, all: Grant[], given?: readonly Grant[]): Grant[] => {
    const nodeId = principalKind(principal) === 'node' ? principal.slice('node:'.length) : null
    const live = given ?? (nodeId && deps.workspaces ? cableGrants(deps.workspaces(), nodeId) : [])
    const cable = live.filter((g) => g.subject === principal)
    const firstUser = all.findIndex((g) => g.origin !== 'builtin')
    const cut = firstUser < 0 ? all.length : firstUser
    return [...all.slice(0, cut), ...cable, ...all.slice(cut)]
  }

  const judge = (principal: Principal, capability: string, args: DecideArgs): Decision => {
    if (!principalKind(principal)) return { effect: 'deny', reason: 'unknown principal' }
    const all = store.grants()
    const at = now()
    let d = evaluate(rulesFor(principal, all, args.cable), { principal, capability, resource: args.resource, now: at })
    for (const parent of store.ancestors(principal)) {
      const pd = evaluate(rulesFor(parent, all), { principal: parent, capability, resource: args.resource, now: at })
      const next = stricter(d, pd)
      if (next !== d) d = { ...next, reason: `attenuated by parent ${parent}: ${next.reason}` }
    }
    const destructive = args.destructive ?? DESTRUCTIVE.has(capability)
    if (destructive && d.effect === 'allow' && d.origin !== 'human-ui' && d.origin !== 'builtin') {
      d = { ...d, effect: 'ask', reason: `destructive capability is never auto-allowed by a ${d.origin} rule` }
    }
    return d
  }

  const record = (kind: string, principal: Principal, payload: Record<string, unknown>, args: { resource?: string; workspaceId?: string } = {}): void => {
    const nodeId = principalKind(principal) === 'node' ? principal.slice('node:'.length) : null
    events.append({
      kind, source: 'policy', actor: principal.length <= MAX_ACTOR && principalKind(principal) ? principal : 'unknown', trust: 'trusted',
      subject: args.resource ?? null, workspaceId: args.workspaceId ?? null, nodeId: nodeId && nodeId.length <= 512 ? nodeId : null, payload,
    })
  }

  return {
    store,

    /** Decides and records the decision as a `policy.decision` event. */
    decide(principal: Principal, capability: string, args: DecideArgs = {}): Decision {
      const d = judge(principal, capability, args)
      record(DECISION_EVENT, principal, { capability, effect: d.effect, reason: d.reason, ...(d.ruleId ? { ruleId: d.ruleId } : {}) }, args)
      return d
    },

    /**
     * Writes a rule on behalf of `actor`. Agents (central, node, routine) can never mint grants (K3);
     * Telegram may only write an expiring "allow once" rule; permanent rules are human-ui only (K4).
     */
    createGrant(actor: Principal, input: GrantInput): GrantResult {
      const kind = principalKind(actor)
      if (!kind) return { ok: false, status: 403, code: 'unknown_principal' }
      if (isAgentPrincipal(actor)) return { ok: false, status: 403, code: 'agent_cannot_grant' }
      const expiresAt = input.expiresAt ?? null
      if (kind === 'telegram' && (expiresAt === null || expiresAt - now() > TELEGRAM_GRANT_MAX_MS)) {
        return { ok: false, status: 403, code: 'permanent_rule_ui_only' }
      }
      const scope = input.scope ?? '*'
      if (!validPattern(input.subject) || !validPattern(input.capability) || !validPattern(scope) || !EFFECTS.includes(input.effect)) {
        return { ok: false, status: 400, code: 'invalid_grant' }
      }
      if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now())) return { ok: false, status: 400, code: 'invalid_expiry' }
      const grant = store.insertGrant({
        subject: input.subject, capability: input.capability, scope, effect: input.effect, expiresAt,
        origin: kind === 'human-ui' ? 'human-ui' : 'telegram', createdBy: actor,
      })
      record(GRANT_EVENT, actor, { op: 'create', id: grant.id, subject: grant.subject, capability: grant.capability, scope, effect: grant.effect, expiresAt })
      return { ok: true, grant }
    },

    /** Revokes a rule; agents cannot (revoking a deny would raise their power). */
    revokeGrant(actor: Principal, id: string): { ok: true } | { ok: false; status: 403 | 404; code: string } {
      if (!principalKind(actor) || isAgentPrincipal(actor)) return { ok: false, status: 403, code: 'agent_cannot_grant' }
      if (!store.revokeGrant(id)) return { ok: false, status: 404, code: 'not_found' }
      record(GRANT_EVENT, actor, { op: 'revoke', id })
      return { ok: true }
    },

    /** Records that `child` was spawned by `parent`; the child's decisions are capped by the parent's (K3). */
    registerSpawn(parent: Principal, child: Principal): void {
      store.setParent(child, parent)
    },
  }
}

export type Policy = ReturnType<typeof createPolicy>
