// Policy model (PLAN/01-arsitektur.md S2): principals, grants and the pure last-match-wins evaluator.
// No I/O, no bun:sqlite: vitest-safe.
//
// Imitated designs:
// - OpenCode permissions (opencode.ai/docs/permissions): "Rules are evaluated by pattern match, with
//   the last matching rule winning"; `*` matches zero or more characters, `?` exactly one; the three
//   actions are allow / ask / deny.
// - Orca `src/main/runtime/rpc/rpc-caller-scope.ts`: the transport stamps a PROVEN caller scope and
//   the scope, not the request text, decides what a caller may do; "Delegated phones inherit at most
//   their paired desktop's scope" is the attenuation rule used for child nodes here (K3).
// - Orca `rpc-method-permission.ts:1-3`: every method declares its permission up front; here the
//   capability registry tier (`capability/capability.define.ts`) plays that role and the per-tier
//   minimum level is data (`policy_tier_min`).

export type Effect = 'allow' | 'ask' | 'deny'
export const EFFECTS: readonly Effect[] = ['allow', 'ask', 'deny']

/** Proven caller identity: `human-ui`, `central`, `node:<id>`, `telegram:<chat>`, `routine:<id>`. */
export type Principal = string
export type PrincipalKind = 'human-ui' | 'central' | 'node' | 'telegram' | 'routine'

/** Where a rule came from; only `human-ui` rules may be permanent (K4). */
export type GrantOrigin = 'builtin' | 'cable' | 'human-ui' | 'telegram'

export interface Grant {
  id: string
  /** Principal pattern, e.g. `node:abc`, `node:*`, `telegram:*`. */
  subject: string
  /** Capability pattern, e.g. `browser.*`, `node.close`, `*`. */
  capability: string
  /** Resource pattern, e.g. `node:b1`, `workspace:w1*`, `*`. */
  scope: string
  /** Workspace the rule is limited to (agents on that board only); null/absent = every workspace. */
  workspaceId?: string | null
  effect: Effect
  /** Epoch ms; null = permanent. */
  expiresAt: number | null
  origin: GrantOrigin
  createdBy: Principal
  createdAt: number
}

export interface Decision {
  effect: Effect
  reason: string
  /** Id of the rule that decided, absent when nothing matched. */
  ruleId?: string
  origin?: GrantOrigin
}

const PRINCIPAL_RE = /^(human-ui|central|(node|telegram|routine):[\w.:-]{1,200})$/

/** Kind of a well-formed principal, else null. */
export function principalKind(p: string): PrincipalKind | null {
  if (!PRINCIPAL_RE.test(p)) return null
  const head = p.split(':')[0]
  return head as PrincipalKind
}

/** Agents (anything not a human at the UI or a human's chat) can never mint grants (K3). */
export function isAgentPrincipal(p: Principal): boolean {
  const kind = principalKind(p)
  return kind === 'central' || kind === 'node' || kind === 'routine'
}

const reCache = new Map<string, RegExp>()

/** OpenCode wildcard match: `*` = any run (also empty), `?` = one char, everything else literal. */
export function wildcardMatch(pattern: string, value: string): boolean {
  let re = reCache.get(pattern)
  if (!re) {
    const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    re = new RegExp(`^${body}$`, 's')
    if (reCache.size > 1000) reCache.clear()
    reCache.set(pattern, re)
  }
  return re.test(value)
}

export interface DecideQuery {
  principal: Principal
  capability: string
  /** Resource acted on; `*`-only rules match when absent. */
  resource?: string
  /** Workspace of the caller; a workspace-limited rule matches only when this equals its `workspaceId`. */
  workspaceId?: string
  now: number
}

/** True when `g` is live at `now` and matches the query. */
export function grantMatches(g: Grant, q: DecideQuery): boolean {
  if (g.expiresAt !== null && q.now >= g.expiresAt) return false
  if (g.workspaceId != null && g.workspaceId !== q.workspaceId) return false
  return wildcardMatch(g.subject, q.principal)
    && wildcardMatch(g.capability, q.capability)
    && (g.scope === '*' || (q.resource !== undefined && wildcardMatch(g.scope, q.resource)))
}

/** Last matching rule wins; no match = deny (fail closed). `rules` are in evaluation order. */
export function evaluate(rules: readonly Grant[], q: DecideQuery): Decision {
  for (let i = rules.length - 1; i >= 0; i--) {
    const g = rules[i]
    if (grantMatches(g, q)) return { effect: g.effect, reason: `${g.origin} rule ${g.id}: ${g.effect} ${g.capability} on ${g.scope}`, ruleId: g.id, origin: g.origin }
  }
  return { effect: 'deny', reason: 'no rule matches' }
}

const RANK: Record<Effect, number> = { deny: 0, ask: 1, allow: 2 }

/** The stricter of two decisions (attenuation: a child never gets more than its parent). */
export function stricter(a: Decision, b: Decision): Decision {
  return RANK[b.effect] < RANK[a.effect] ? b : a
}
