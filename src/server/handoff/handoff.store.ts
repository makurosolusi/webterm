// Ledger side of handoff cards: SYSTEM evidence read from the Senses log + cost ledger, and the cards
// themselves stored as chained `handoff.card` events attached to their node (no new table: the hash
// chain already makes them tamper-evident). SQL only; the wording lives in ./handoff.model.
import type { Database } from 'bun:sqlite'
import { spentMicros } from '../cost/costStore'
import type { EventLog } from '../events/eventLog'
import { allRows, getRow } from '../ledger/ledgerCore'
import { HANDOFF_CARD_EVENT, type HandoffCard, type HandoffCheck, type HandoffEvidence, type HandoffReceipt } from './handoff.model'

/** Evidence window of a node's first card. */
export const EVIDENCE_WINDOW_MS = 7 * 24 * 60 * 60_000
const MAX_RECEIPTS = 10
const MAX_CHECKS = 10
const VERDICT_EVENT = 'verifier.verdict'

// Terminal panes report `<nodeId>:<pane>`; they belong to the node.
const NODE_MATCH = '(node_id = ? OR node_id LIKE ? ESCAPE \'\\\')'
const nodeArgs = (nodeId: string): [string, string] => [nodeId, `${nodeId.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`]

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const parse = (v: unknown): unknown => { try { return typeof v === 'string' ? JSON.parse(v) : null } catch { return null } }

/** Newest card of a node, or null. */
export function latestCard(db: Database, nodeId: string): HandoffCard | null {
  const row = getRow(db, `SELECT payload_json FROM event WHERE hash IS NOT NULL AND kind = ? AND node_id = ? ORDER BY seq DESC LIMIT 1`, HANDOFF_CARD_EVENT, nodeId)
  return row ? (parse(row['payload_json']) as HandoffCard | null) : null
}

/** Time of the node's newest hook event (agent activity), or null. */
export function lastActivity(db: Database, nodeId: string): number | null {
  const row = getRow(db, `SELECT MAX(ts) AS t FROM event WHERE hash IS NOT NULL AND kind LIKE 'hook.%' AND ${NODE_MATCH}`, ...nodeArgs(nodeId))
  return row?.['t'] == null ? null : Number(row['t'])
}

/** Everything a card states as fact, from the ledger only. */
export function collectEvidence(db: Database, nodeId: string, since: number): HandoffEvidence {
  const turns = Number(getRow(db, `SELECT COUNT(*) AS n FROM event WHERE hash IS NOT NULL AND kind = 'hook.Stop' AND ts > ? AND ${NODE_MATCH}`, since, ...nodeArgs(nodeId))?.['n'] ?? 0)
  const verdicts = allRows(db, `SELECT payload_json FROM event WHERE hash IS NOT NULL AND kind = ? AND ts > ? AND ${NODE_MATCH} ORDER BY seq DESC LIMIT ?`, VERDICT_EVENT, since, ...nodeArgs(nodeId), MAX_RECEIPTS)
    .map((r) => obj(parse(r['payload_json'])))
  const receipts: HandoffReceipt[] = verdicts.map((p) => ({ taskId: String(p['taskId'] ?? ''), status: String(p['status'] ?? ''), summary: String(p['summary'] ?? '') }))
  const newest = obj(obj(verdicts[0]?.['receipt'])['evidence'])
  const checks: HandoffCheck[] = (Array.isArray(newest['commands']) ? newest['commands'] : []).slice(0, MAX_CHECKS).map((c) => {
    const o = obj(c)
    return { command: String(o['command'] ?? ''), exitCode: typeof o['exitCode'] === 'number' ? o['exitCode'] : null }
  })
  const spend = spentMicros(db, { since, nodeId })
  return {
    since,
    turns,
    filesChanged: typeof newest['filesChanged'] === 'number' ? newest['filesChanged'] : null,
    diffStat: typeof newest['diffStat'] === 'string' && newest['diffStat'] !== '' ? newest['diffStat'] : null,
    checks,
    receipts,
    costMicros: spend.costMicros > 0 || spend.unpriced > 0 ? spend.costMicros : null,
    unpricedResponses: spend.unpriced,
  }
}

/** Appends the card as a chained event on its node. */
export function storeCard(log: EventLog, card: HandoffCard): void {
  log.append({
    kind: HANDOFF_CARD_EVENT, source: 'handoff', actor: 'handoff', subject: `node:${card.nodeId}`,
    nodeId: card.nodeId, workspaceId: card.workspaceId, trust: 'trusted', payload: card, ts: card.createdAt,
  })
}
