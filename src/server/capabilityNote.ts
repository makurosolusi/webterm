// "[webterm] Capabilities updated: ..." for a session whose abilities changed since its previous turn. A resumed agent keeps
// the system prompt it started with, so a changed briefing never reaches it by itself. The hash of the briefing each scope
// (one Central conversation, one Agent Chat node) last saw lives in the ledger `event` table (audit rows, so the existing
// event retention bounds them; a scope idle past it simply records again). One indexed lookup per turn, nothing otherwise.
import { capabilityHash, renderCapabilityBriefing, renderCapabilityLine, type CapabilityId, type ProfileId } from '../shared/agentCapabilities'
import { allRows, getRow, type LedgerContext } from './ledger/ledgerCore'
import { appendEvent } from './ledger/ledgerEvent'

export const CAPABILITY_SEEN_KIND = 'agent.capabilities'
const ACTOR = 'system:capabilities'

export interface CapabilityNote {
  /** Model-facing text: the one-line summary plus the full briefing, rendered once. */
  text: string
  /** One line for the visible system notice. */
  line: string
}

/**
 * Compares the briefing hash of `profile` (with `off` abilities) to the one recorded for `scope`, then records the current one.
 * `live` = runtime facts appended to the briefing (the browser profile names): a change in them also triggers the note.
 * First sight of a scope only records. Undefined = nothing to say.
 */
export function capabilityNote(ctx: LedgerContext, scope: string, profile: ProfileId, off: ReadonlySet<CapabilityId> = new Set(), live = ''): CapabilityNote | undefined {
  const hash = capabilityHash(profile, off, live)
  const last = getRow(ctx.db, 'SELECT payload_json FROM event WHERE kind = ? AND correlation_id = ? ORDER BY seq DESC LIMIT 1', CAPABILITY_SEEN_KIND, scope)
  const seen = last ? (JSON.parse(String(last.payload_json)) as { hash?: unknown }).hash : undefined
  if (seen === hash) return undefined
  appendEvent(ctx, { actor: ACTOR, kind: CAPABILITY_SEEN_KIND, correlationId: scope, payload: { profile, hash } })
  if (seen === undefined) return undefined
  const line = `[webterm] Capabilities updated: ${renderCapabilityLine(profile, off)}${live ? ` ${live}` : ''}`
  return { line, text: `${line}\n${renderCapabilityBriefing(profile, off)}${live ? `\n${live}` : ''}` }
}

/** Newest-first recorded hashes of a scope (tests, diagnostics). */
export const recordedCapabilityHashes = (ctx: LedgerContext, scope: string, limit = 20): string[] =>
  allRows(ctx.db, 'SELECT payload_json FROM event WHERE kind = ? AND correlation_id = ? ORDER BY seq DESC LIMIT ?', CAPABILITY_SEEN_KIND, scope, limit)
    .map((r) => String((JSON.parse(String(r.payload_json)) as { hash?: unknown }).hash))
