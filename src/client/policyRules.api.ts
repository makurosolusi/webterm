// Data side of Settings › Rules & secrets: the `/api/policy/grants` requests, one "create a rule" call shared by
// the rule list, the quick "Always allow / block" rules, the Advanced form and Secrets' Allow, and the event
// that tells the list to reload after any of them wrote. The server accepts these writes from this page only (K4).

export const POLICY_GRANTS_PATH = '/api/policy/grants'
/** Recent Claude permission prompts with a safe pattern (server permission.human.ts `listRecentPermissions`). */
export const RECENT_ASKS_PATH = '/api/approvals/permission?recent=1'

/** Mirror of the server `Grant` (src/server/policy/policy.model.ts). */
export interface PolicyGrant {
  id: string; subject: string; capability: string; scope: string; effect: 'allow' | 'ask' | 'deny'
  expiresAt: number | null; origin: string; createdBy: string; createdAt: number
}
export type NewRule = Pick<PolicyGrant, 'subject' | 'capability' | 'scope' | 'effect'> & { expiresAt?: number }

/** Mirror of the server `RecentPermission`. */
export interface RecentAsk { tool: string; label: string; pattern: string; node: string; createdAt: number }

/** Fetch (the session cookie rides along); throws with the server's error code (or the status) on failure. */
export async function policyRequest(method: string, path = POLICY_GRANTS_PATH, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error((out as { error?: string } | null)?.error ?? `${method} ${path} -> ${res.status}`)
  return out
}

/** Window event fired after any rule write, so the rule list reloads wherever the write came from. */
export const RULES_CHANGED_EVENT = 'webterm:policy-rules-changed'

/** Creates a rule and tells the list; throws with the server's reason. */
export async function createRule(rule: NewRule): Promise<void> {
  await policyRequest('POST', POLICY_GRANTS_PATH, rule)
  window.dispatchEvent(new Event(RULES_CHANGED_EVENT))
}

export const isGrants = (v: unknown): v is { grants: PolicyGrant[] } => !!v && Array.isArray((v as { grants?: unknown }).grants)
export const isAsks = (v: unknown): v is { items: RecentAsk[] } => !!v && Array.isArray((v as { items?: unknown }).items)
