// Central principal mode of the MCP backend (PLAN F2-c, K7). Claude Code running as Central calls the
// registry natively through the same stdio server nodes use, instead of emitting text proposals.
// Authority: a per-turn capability token the Central runtime minted (`mintedBy` = `central-mcp:<conv>`),
// never a field of the request. Every call runs `execTool` behind the CA2 control guard
// (level -> pause -> caps -> budget -> doom-loop -> breaker -> policy). A guard `needs_approval` becomes a
// ledger approval card (the existing inbox/Telegram card UX); the approved call runs once, because
// `consumeApproval` is single-use and its digest pins the exact tool + input.
import type { Database } from 'bun:sqlite'
import type { CapabilitySpec } from '../capability/capability.define'
import { checkSchema } from '../capability/capability.schema'
import { type SyncControlGuard, toToolGuard } from '../central/guard/controlGuard'
import { brokerSecretValues } from '../central/runtime/runtimeEvents'
import { toolCapability } from '../central/tools/toolCapability'
import { execToolReceipt } from '../central/tools/toolExec'
import { type ToolRegistry, defEnabled } from '../central/tools/toolTypes'
import { approvalDigest, consumeApproval, requestApproval } from '../ledger/ledgerApproval'
import { allRows } from '../ledger/ledgerCore'
import { redactValue } from '../redactSecrets'
import { APPROVAL_PENDING, CENTRAL_MCP_MINTER } from './mcp.paths'
import type { McpTool } from './mcp.protocol'
import { type McpReceipt, mcpName, redactToolArgs } from './mcp.tools'

/**
 * Tools whose handler runs its own approval (agent.spawn cards + resume sweep, task.run's worker.run
 * approval, channel.bot.propose's typed-confirm approval). A second generic card would ask twice, so
 * for these the guard's `needs_approval` passes and the handler decides; denies still deny. Their receipts
 * still carry the card's ledger `approvalStatus` (toolExec.ts), so an expired/rejected card is never reported as waiting.
 */
const OWN_APPROVAL_TOOLS: ReadonlySet<string> = new Set(['agent.spawn', 'task.run', 'channel.bot.propose'])
const APPROVAL_ID_PREFIX = 'ct-'
const APPROVAL_HASH_CHARS = 24

type Env = Record<string, string | undefined>
export interface CentralMcpDeps {
  db: Database; registry: ToolRegistry; env: Env; guard: SyncControlGuard; now?: () => number
  /** Broker-held secret values to mask in tool input (tests); absent = the real broker store. */
  secretValues?: () => readonly string[]
}

/** Conversation a capability record speaks for; null when it was not minted for Central's MCP child. */
export function centralConversationOf(record: { mintedBy?: string } | undefined): string | null {
  const by = record?.mintedBy
  return by?.startsWith(CENTRAL_MCP_MINTER) && by.length > CENTRAL_MCP_MINTER.length ? by.slice(CENTRAL_MCP_MINTER.length) : null
}

/** Registry tools Central sees, keyed by MCP name; throws if two names collapse to one. */
export function centralCapabilities(c: Pick<CentralMcpDeps, 'registry' | 'env'>): Map<string, CapabilitySpec> {
  const out = new Map<string, CapabilitySpec>()
  for (const def of c.registry.list()) {
    if (!defEnabled(def, c.env)) continue
    const name = mcpName(def.name)
    if (out.has(name)) throw new Error(`mcp tool name ${name} is claimed by two capabilities`)
    out.set(name, toolCapability(def))
  }
  return out
}

/** `tools/list` for Central: schema straight from the registry, tier in the description. */
export function listCentralTools(c: Pick<CentralMcpDeps, 'registry' | 'env'>): McpTool[] {
  return [...centralCapabilities(c)].map(([name, cap]) => ({
    name,
    description: `${cap.summary} (webterm ${cap.name}, tier ${cap.tier}${cap.tier >= 'R2' ? ', needs human approval unless the level allows it' : ''})`,
    inputSchema: { ...(cap.input ?? { type: 'object' }) } as Record<string, unknown>,
    annotations: { readOnlyHint: cap.tier === 'R0', destructiveHint: !!cap.destructive, idempotentHint: !!cap.idempotent },
  }))
}

const receipt = (outcome: McpReceipt['outcome'], detail: string, data: unknown = null, next: string | null = null, evidence: Record<string, unknown> = {}): McpReceipt =>
  ({ outcome, detail, next, evidence, operationId: null, data })

interface ApprovalRow { id: string; status: string; expiresAt: number | null; unused: boolean }

/** Approval ids of one exact call: `ct-<hash>`, then `ct-<hash>-2`, ... once an earlier card is spent. */
function approvalBase(conversationId: string, tool: string, args: Record<string, unknown>): string {
  return `${APPROVAL_ID_PREFIX}${approvalDigest({ conversationId, tool, args }).slice(0, APPROVAL_HASH_CHARS)}`
}

function approvalsOf(db: Database, base: string): ApprovalRow[] {
  // `base` is hex behind a fixed prefix, so the LIKE pattern carries no wildcard from input.
  return allRows(db, `SELECT a.id, a.status, a.expires_at, d.single_use FROM approval a JOIN decision d ON d.id = a.decision_id
    WHERE a.id = ? OR a.id LIKE ? ORDER BY a.created_at DESC, a.rowid DESC`, base, `${base}-%`)
    .map((r) => ({ id: String(r.id), status: String(r.status), expiresAt: r.expires_at === null ? null : Number(r.expires_at), unused: Number(r.single_use) === 1 }))
}

/** The card payload a human reads; the digest the ledger takes over it pins the exact call. */
function approvalRequest(conversationId: string, tool: string, args: Record<string, unknown>): Record<string, unknown> {
  return { tool, conversationId, input: redactValue(args), inputDigest: approvalDigest(args) }
}

const pendingReceipt = (approvalId: string, expiresAt: number | null): McpReceipt => receipt('denied', 'approval_required', { approvalId, status: APPROVAL_PENDING, expiresAt },
  'an approval card is shown in the Central chat; tell the human what it asks, then call the same tool with the same input again after they approve',
  { approvalId, approvalStatus: APPROVAL_PENDING })

async function exec(c: CentralMcpDeps, conversationId: string, tool: string, args: Record<string, unknown>, approved: boolean): Promise<{ receipt: McpReceipt; projectId?: string; ownCard: boolean }> {
  const guard = toToolGuard(c.guard, { approved })
  const ctx = { db: c.db, registry: c.registry, guard, maxTier: 'R3' as const, conversationId, now: c.now ?? Date.now, env: c.env }
  const { receipt: r, result } = await execToolReceipt(ctx, tool, args)
  const ownCard = typeof (result?.data as { approvalId?: unknown } | undefined)?.approvalId === 'string'
  return { receipt: { ...r, data: result?.data ?? null }, ...(result?.projectId ? { projectId: result.projectId } : {}), ownCard }
}

/** Runs one Central MCP call; never throws for a bad call. */
export async function callCentralTool(c: CentralMcpDeps, conversationId: string, name: string, raw: Record<string, unknown>): Promise<McpReceipt> {
  const cap = centralCapabilities(c).get(name)
  if (!cap) return receipt('error', 'unknown_tool', null, 'tools/list or cap_search shows the tools that exist')
  // Scrubbed first, so the guard, approval digest, receipts and every store see only redacted input (K7-F1).
  const args = redactToolArgs(cap.name, raw, c.secretValues ?? (() => brokerSecretValues()))
  const violation = cap.input ? checkSchema(cap.input, args) : null
  if (violation !== null) return receipt('error', 'invalid_shape', null, 'tools/list shows the exact input schema', { violation })
  const tool = cap.name
  if (OWN_APPROVAL_TOOLS.has(tool)) return (await exec(c, conversationId, tool, args, true)).receipt

  const now = (c.now ?? Date.now)()
  const base = approvalBase(conversationId, tool, args)
  const cards = approvalsOf(c.db, base)
  const latest = cards[0]
  const expired = latest !== undefined && latest.status === 'pending' && latest.expiresAt !== null && latest.expiresAt <= now
  if (latest && !expired) {
    if (latest.status === 'pending' && !c.guard.skipsApprovals()) return pendingReceipt(latest.id, latest.expiresAt)
    if (latest.status === 'rejected') return receipt('denied', 'approval_rejected', { approvalId: latest.id }, 'the human rejected this exact call; do not retry it', { approvalId: latest.id, approvalStatus: 'rejected' })
    if (latest.status === 'approved' && latest.unused) {
      const digest = approvalDigest(approvalRequest(conversationId, tool, args))
      // Single use: a concurrent poll that lost the race sees false and must not run the tool again.
      if (!consumeApproval({ db: c.db, now: () => now }, latest.id, { digest })) return receipt('denied', 'approval_used', { approvalId: latest.id }, null, { approvalId: latest.id, approvalStatus: 'approved' })
      const ran = await exec(c, conversationId, tool, args, true)
      return { ...ran.receipt, evidence: { ...ran.receipt.evidence, approvalId: latest.id, approvalStatus: 'approved' } }
    }
  }
  const first = await exec(c, conversationId, tool, args, false)
  if (first.receipt.detail !== 'approval_required' || first.ownCard) return first.receipt
  // The ledger keys every card to a project; a global tool that needs approval cannot get one here.
  if (!first.projectId) return receipt('denied', 'approval_needs_project', null, 'ask the human to run this from the webterm UI')
  const id = cards.length === 0 ? base : `${base}-${cards.length + 1}`
  const challenge = requestApproval({ db: c.db, now: () => now }, { id, projectId: first.projectId, kind: tool, request: approvalRequest(conversationId, tool, args) })
  return pendingReceipt(challenge.id, challenge.expiresAt)
}
