// Answers a Claude Code `PermissionRequest` from webterm (F3-b): a human-ui "always allow" rule
// answers at once; otherwise a ledger approval appears in the Inbox (and is decidable from Telegram
// `/approve <id>`, which writes the same approval row) and the hook request is held until a human
// decides or the wait runs out. Timeout = no decision = Claude's own prompt in the terminal.
import type { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { approvalDigest, consumeApproval, getApproval, requestApproval } from '../ledger/ledgerApproval'
import type { AppendEventInput } from '../events/eventModel'
import { execWrite } from '../ledger/ledgerCore'
import type { Policy } from '../policy/policy.decide'
import {
  PERMISSION_ID_PREFIX,
  PERMISSION_KIND,
  TOOL_CAPABILITY_PREFIX,
  permissionDecision,
  suggestedPattern,
  toolLabel,
  toolName,
  toolResource,
  type PermissionBody,
  type PermissionOutput,
} from './permission.model'

export const PERMISSION_DECISION_EVENT = 'permission.decision'
export const PERMISSION_REQUEST_EVENT = 'permission.request'
/** Ledger poll period while a request is held: SQLite reads are cheap, and a human is slower. */
export const PERMISSION_POLL_MS = 500

export interface PermissionWaitDeps {
  db: Database
  policy: Pick<Policy, 'evaluate' | 'store'>
  /** Ledger project of the node's workspace; null = no project, so no inbox item (prompt as before). */
  projectId: string | null
  waitMs: number
  record: (e: AppendEventInput) => void
  now?: () => number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface PermissionAsk {
  nodeId: string
  /** Node title on the canvas (`brisk-otter`), shown in the inbox. */
  nodeTitle: string
  workspaceId: string | null
  body: PermissionBody
  /** Aborted when the hook's curl goes away (Claude was closed or answered elsewhere). */
  signal?: AbortSignal
}

/** The request stored on the approval row: what the human sees and what "always allow" saves. */
export interface PermissionRequestView {
  nodeId: string
  node: string
  tool: string
  label: string
  /** Always-allow scope pattern; null = no safe pattern, so the UI offers no "always". */
  pattern: string | null
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A live human-ui rule on `claude.tool:*` decides; any other rule (builtin node deny, control grants) never does. */
function ruleDecision(deps: PermissionWaitDeps, ask: PermissionAsk): { behavior: 'allow' | 'deny'; ruleId: string } | null {
  const d = deps.policy.evaluate(`node:${ask.nodeId}`, `${TOOL_CAPABILITY_PREFIX}${toolName(ask.body)}`, { resource: toolResource(ask.body) })
  if (d.origin !== 'human-ui' || !d.ruleId || d.effect === 'ask') return null
  const rule = deps.policy.store.grants().find((g) => g.id === d.ruleId)
  if (!rule?.capability.startsWith(TOOL_CAPABILITY_PREFIX)) return null
  return { behavior: d.effect, ruleId: d.ruleId }
}

/** Decision JSON for the hook reply, or null for "no decision" (Claude prompts in the terminal). */
export async function answerPermission(deps: PermissionWaitDeps, ask: PermissionAsk): Promise<PermissionOutput | null> {
  const now = deps.now ?? Date.now
  const label = toolLabel(ask.body)
  const event = (payload: Record<string, unknown>, actor = `node:${ask.nodeId}`, kind = PERMISSION_DECISION_EVENT): void =>
    deps.record({ kind, source: 'permission', actor: /^[\w.:-]{1,64}$/.test(actor) ? actor : 'agent', trust: 'trusted', subject: `node:${ask.nodeId}`, nodeId: ask.nodeId, workspaceId: ask.workspaceId, payload: { tool: toolName(ask.body), label, ...payload } })

  const rule = ruleDecision(deps, ask)
  if (rule) {
    event({ behavior: rule.behavior, by: 'rule', ruleId: rule.ruleId }, 'human-ui')
    return permissionDecision(rule.behavior, rule.behavior === 'deny' ? `Denied by a webterm rule (${rule.ruleId}).` : undefined)
  }
  if (!deps.projectId || deps.waitMs <= 0 || ask.signal?.aborted) return null

  const ctx = { db: deps.db, now }
  const request: PermissionRequestView = { nodeId: ask.nodeId, node: ask.nodeTitle, tool: toolName(ask.body), label, pattern: suggestedPattern(ask.body) }
  const id = `${PERMISSION_ID_PREFIX}${randomBytes(8).toString('hex')}`
  // TTL = the wait: the row expires (and leaves the inbox) exactly when the hook stops listening.
  requestApproval(ctx, { id, projectId: deps.projectId, kind: PERMISSION_KIND, request, ttlMs: deps.waitMs })
  event({ approvalId: id, pattern: request.pattern }, `node:${ask.nodeId}`, PERMISSION_REQUEST_EVENT)

  const deadline = now() + deps.waitMs
  const sleep = deps.sleep ?? defaultSleep
  while (!ask.signal?.aborted && now() < deadline) {
    const a = getApproval(ctx, id)
    if (a?.status === 'approved') {
      // Single use, like every other approval: a second reader can never replay this consent.
      const used = consumeApproval(ctx, id, { digest: approvalDigest(a.request) })
      event({ approvalId: id, behavior: used ? 'allow' : 'none', by: a.approvedBy }, a.approvedBy ?? 'human-ui')
      return used ? permissionDecision('allow') : null
    }
    if (a?.status === 'rejected') {
      event({ approvalId: id, behavior: 'deny', by: a.approvedBy }, a.approvedBy ?? 'human-ui')
      return permissionDecision('deny', `The user denied ${label} in webterm. Do not retry it; ask what to do instead.`)
    }
    if (!a || a.status === 'expired') break
    await sleep(deps.pollMs ?? PERMISSION_POLL_MS)
  }
  // Nobody is listening any more: take the card out of the inbox now instead of at its TTL.
  execWrite(deps.db, "UPDATE approval SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'", now(), id)
  event({ approvalId: id, behavior: 'none', by: ask.signal?.aborted ? 'hook_closed' : 'timeout' })
  return null
}
