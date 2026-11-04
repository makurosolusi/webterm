// F4-d hook of the classifier into Central's act_gated decisions. Only a `needs_approval` that came from the tier
// ladder (R2 at act_gated) is eligible: a human `ask` rule, R3, and anything below act_gated never are. The guard
// stays synchronous: the approval card is created by the caller right after the verdict (mcp/mcp.central.ts), so
// classification runs a tick later, finds that exact card (same tool + input digest) and approves it on `allow`.
// The agent's retry then consumes the card as if a human had clicked.
import type { Database } from 'bun:sqlite'
import { allRows, getRow } from '../../ledger/ledgerCore'
import { approvalDigest } from '../../ledger/ledgerApproval'
import type { AppendEventInput } from '../../events/eventModel'
import type { Policy } from '../../policy/policy.decide'
import { classifierSwitch, type Classifier, type GatedOutcome } from '../../policy/policy.classifier'
import { classifyCard } from '../../policy/policy.classifier.card'
import type { GuardDecision, Tier } from '../contracts/level.types'

const CARD_PREFIX = 'ct-'
const LOOKUP_TRIES = 5
const LOOKUP_GAP_MS = 100
const CARD_SCAN = 20

export interface GuardClassifierDeps {
  db: Database
  now: () => number
  policy: Policy
  classifier?: Classifier
  record?: (e: AppendEventInput) => void
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface GatedToolCall { tool: string; tier: Tier; projectId?: string; input: Record<string, unknown>; destructive?: boolean }

/** True when the verdict is the ladder's own per-action ask (not a rule, not R3). */
export function classifiable(policy: Policy, req: GatedToolCall, d: GuardDecision): boolean {
  if (d.verdict !== 'needs_approval' || d.level !== 'act_gated' || d.tier !== 'R2') return false
  return policy.evaluate('central', req.tool, req.projectId ? { resource: `project:${req.projectId}` } : {}).effect !== 'ask'
}

function findCard(db: Database, tool: string, digest: string): string | null {
  const rows = allRows(db, "SELECT id, request_json FROM approval WHERE status = 'pending' AND kind = ? AND id LIKE ? ORDER BY created_at DESC LIMIT ?", tool, `${CARD_PREFIX}%`, CARD_SCAN)
  for (const r of rows) {
    const req = JSON.parse(String(r['request_json'])) as { inputDigest?: unknown }
    if (req.inputDigest === digest) return String(r['id'])
  }
  return null
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Classifies the card of `req` once it appears; null when off, ineligible, or no card showed up. */
export async function classifyGuardCall(deps: GuardClassifierDeps, req: GatedToolCall, d: GuardDecision): Promise<GatedOutcome | null> {
  if (!classifierSwitch(deps.db).central || !classifiable(deps.policy, req, d)) return null
  const sleep = deps.sleep ?? defaultSleep
  const digest = approvalDigest(req.input)
  let id: string | null = null
  // ponytail: polls a few ticks for the caller's card; an event from requestApproval would remove the wait.
  for (let i = 0; i < LOOKUP_TRIES && !id; i++) {
    await sleep(i === 0 ? 0 : LOOKUP_GAP_MS)
    id = findCard(deps.db, req.tool, digest)
  }
  if (!id) return null
  const project = req.projectId ? getRow(deps.db, 'SELECT path, workspace_id FROM project WHERE id = ?', req.projectId) : null
  return classifyCard({ db: deps.db, now: deps.now, ...(deps.classifier ? { classifier: deps.classifier } : {}), ...(deps.record ? { record: deps.record } : {}), ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) }, {
    principal: 'central', capability: req.tool, tier: req.tier, args: req.input, approvalId: id, destructive: req.destructive === true,
    projectId: req.projectId ?? null, cwd: project ? String(project['path']) : null, workspaceId: project?.['workspace_id'] ? String(project['workspace_id']) : null,
  })
}
