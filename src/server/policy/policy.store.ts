// SQLite persistence for the policy model (ledger schema v11, `workspace_id` since v31): grants, tier minima, node lineage and
// principal tokens. The DB handle is injected; only bun:sqlite types are imported.
import type { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { allRows, execWrite, getRow, type Row } from '../ledger/ledgerCore'
import type { ControlLevel, Tier } from '../central/contracts/level.types'
import type { Effect, Grant, GrantOrigin, Principal } from './policy.model'

/** Pre-v11 constant (`controlGuard.ts` MIN_LEVEL); used only when a tier row is missing. */
export const FALLBACK_TIER_MIN: Record<Tier, ControlLevel> = { R0: 'observe', R1: 'propose', R2: 'act_gated', R3: 'propose' }
/** Lineage walk bound; K3 caps spawn depth at 2, so this is generous. */
export const MAX_LINEAGE = 8

const GRANT_COLS = 'id, subject, capability, scope, workspace_id, effect, expires_at, origin, created_by, created_at'

function toGrant(r: Row): Grant {
  return {
    id: String(r.id), subject: String(r.subject), capability: String(r.capability), scope: String(r.scope),
    workspaceId: r.workspace_id === null || r.workspace_id === undefined ? null : String(r.workspace_id),
    effect: String(r.effect) as Effect, expiresAt: r.expires_at === null ? null : Number(r.expires_at),
    origin: String(r.origin) as GrantOrigin, createdBy: String(r.created_by), createdAt: Number(r.created_at),
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

export type NewGrant = Omit<Grant, 'id' | 'createdAt'>

export function createPolicyStore(db: Database, now: () => number) {
  return {
    /** Live (unrevoked, unexpired) grants in evaluation order: builtin rows first, then by insertion. */
    grants(): Grant[] {
      return allRows(db, `SELECT ${GRANT_COLS} FROM policy_grant WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY origin != 'builtin', ord`, now()).map(toGrant)
    },

    insertGrant(g: NewGrant): Grant {
      const id = `grant_${randomBytes(8).toString('hex')}`
      const at = now()
      const ord = Number(getRow(db, 'SELECT coalesce(max(ord), 0) + 1 AS n FROM policy_grant')?.n ?? 1)
      execWrite(db, `INSERT INTO policy_grant (${GRANT_COLS}, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, g.subject, g.capability, g.scope, g.workspaceId ?? null, g.effect, g.expiresAt, g.origin, g.createdBy, at, ord)
      return { ...g, workspaceId: g.workspaceId ?? null, id, createdAt: at }
    },

    /** Soft revoke (kept for audit). True when a live row changed. */
    revokeGrant(id: string): boolean {
      return execWrite(db, 'UPDATE policy_grant SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), id) > 0
    },

    /** Minimum control level for `tier`, from data. */
    tierMinimum(tier: Tier): ControlLevel {
      const r = getRow(db, 'SELECT min_level FROM policy_tier_min WHERE tier = ?', tier)
      return r ? (String(r.min_level) as ControlLevel) : FALLBACK_TIER_MIN[tier]
    },

    setTierMinimum(tier: Tier, level: ControlLevel): void {
      execWrite(db, 'INSERT INTO policy_tier_min (tier, min_level) VALUES (?, ?) ON CONFLICT(tier) DO UPDATE SET min_level = excluded.min_level', tier, level)
    },

    /** Records that `child` was spawned by `parent` (first write wins: lineage never changes). */
    setParent(child: Principal, parent: Principal): void {
      execWrite(db, 'INSERT OR IGNORE INTO policy_principal (id, parent, created_at) VALUES (?, ?, ?)', child, parent, now())
    },

    /** Ancestors nearest first, bounded by MAX_LINEAGE (also stops a corrupt cycle). */
    ancestors(p: Principal): Principal[] {
      const out: Principal[] = []
      let cur = p
      while (out.length < MAX_LINEAGE) {
        const r = getRow(db, 'SELECT parent FROM policy_principal WHERE id = ?', cur)
        if (!r || r.parent === null) break
        cur = String(r.parent)
        if (cur === p || out.includes(cur)) break
        out.push(cur)
      }
      return out
    },

    /** Issues a principal token; only its sha256 is stored. `ttlMs` absent = until revoked. */
    issueToken(principal: Principal, ttlMs?: number): string {
      const token = `wpt_${randomBytes(32).toString('base64url')}`
      const at = now()
      execWrite(db, 'INSERT INTO policy_token (token_hash, principal, expires_at, created_at) VALUES (?, ?, ?, ?)', sha256(token), principal, ttlMs === undefined ? null : at + ttlMs, at)
      return token
    },

    /** Principal proven by `token`, or undefined for an unknown, revoked or expired token. */
    verifyToken(token: string): Principal | undefined {
      if (typeof token !== 'string' || token === '') return undefined
      const r = getRow(db, 'SELECT principal FROM policy_token WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', sha256(token), now())
      return r ? String(r.principal) : undefined
    },

    revokeTokensOf(principal: Principal): number {
      return execWrite(db, 'UPDATE policy_token SET revoked_at = ? WHERE principal = ? AND revoked_at IS NULL', now(), principal)
    },
  }
}

export type PolicyStore = ReturnType<typeof createPolicyStore>
