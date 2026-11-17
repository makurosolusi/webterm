// Audit trail and Central-turn awareness of the skill on/off switch. Rows live in the ledger `event` table (kind below),
// so the existing event retention bounds them; nothing new is stored. The turn note is derived from those rows, not kept
// as state: "changed since this conversation's previous turn" is a time window over the same trail.
import type { LedgerContext } from '../../ledger/ledgerCore'
import { allRows, getRow } from '../../ledger/ledgerCore'
import { appendEvent } from '../../ledger/ledgerEvent'

export const SKILL_TOGGLE_KIND = 'central.skill.toggled'
const MAX_WINDOW_ROWS = 200
const MAX_PAGE = 200

/** What `SkillAdminStore.setEnabled` reports about the flip it made (latest version of the skill). */
export interface SkillToggle { name: string; version: string; audience: string; from: boolean; to: boolean }

/** One audit row per real flip (a repeat enable/disable changes nothing and writes nothing). */
export function recordSkillToggle(ctx: LedgerContext, t: SkillToggle, actor: string): void {
  if (t.from === t.to) return
  appendEvent(ctx, { actor, kind: SKILL_TOGGLE_KIND, payload: { skill: t.name, version: t.version, audience: t.audience, from: t.from, to: t.to } })
}

export interface SkillToggleRow { seq: number; at: number; actor: string; skill: string; version: string; from: boolean; to: boolean }

/** Newest-first page of toggle rows. */
export function listSkillToggles(ctx: LedgerContext, limit: number, offset: number): SkillToggleRow[] {
  const rows = allRows(ctx.db, 'SELECT seq, ts, actor, payload_json FROM event WHERE kind = ? ORDER BY seq DESC LIMIT ? OFFSET ?', SKILL_TOGGLE_KIND, Math.min(limit, MAX_PAGE), offset)
  return rows.map((r) => {
    const p = JSON.parse(String(r.payload_json)) as Record<string, unknown>
    return { seq: Number(r.seq), at: Number(r.ts), actor: String(r.actor), skill: String(p.skill), version: String(p.version), from: p.from === true, to: p.to === true }
  })
}

/**
 * `[webterm] Skills changed: +a / -b` for central skills whose net state differs from the previous turn of this
 * conversation; undefined on its first turn or when nothing changed (one indexed lookup, no cost otherwise).
 */
export function skillsChangedNote(ctx: LedgerContext, conversationId: string): string | undefined {
  const prev = getRow(ctx.db, 'SELECT started_at FROM central_turn WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1', conversationId)
  if (!prev) return undefined
  const rows = allRows(ctx.db, 'SELECT payload_json FROM event WHERE kind = ? AND ts > ? ORDER BY seq LIMIT ?', SKILL_TOGGLE_KIND, Number(prev.started_at), MAX_WINDOW_ROWS)
  const net = new Map<string, { from: boolean; to: boolean }>()
  for (const r of rows) {
    const p = JSON.parse(String(r.payload_json)) as Record<string, unknown>
    if (p.audience !== 'central') continue
    const name = String(p.skill)
    net.set(name, { from: net.get(name)?.from ?? p.from === true, to: p.to === true })
  }
  const parts = [...net].filter(([, s]) => s.from !== s.to).map(([name, s]) => `${s.to ? '+' : '-'}${name}`)
  return parts.length ? `[webterm] Skills changed: ${parts.join(' / ')}` : undefined
}
