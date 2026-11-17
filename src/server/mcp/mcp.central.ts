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
import { TAINT_REASON, wasTaintedAsk } from '../central/guard/taintStore'
import { brokerSecretValues } from '../central/runtime/runtimeEvents'
import { toolCapability } from '../central/tools/toolCapability'
import { execToolReceipt } from '../central/tools/toolExec'
import { type ToolRegistry, defEnabled } from '../central/tools/toolTypes'
import { approvalDigest, consumeApproval, requestApproval } from '../ledger/ledgerApproval'
import { allRows, getRow } from '../ledger/ledgerCore'
import { redactValue } from '../redactSecrets'
import { isSkillAudience } from '../central/contracts/skill.types'
import { type ConversationMode, isConversationMode, modeAllowsTool } from '../central/chat/conversationMode'
import { WEB_READ_TOOL, authorWebReadArgs, authorWebReadViolation } from './mcp.central.authorWeb'
import { APPROVAL_PENDING, CENTRAL_MCP_MINTER } from './mcp.paths'
import type { McpTool } from './mcp.protocol'
import { type McpReceipt, mcpName, redactToolArgs } from './mcp.tools'

/**
 * Tools whose handler runs its own approval (agent.spawn cards + resume sweep,
 * channel.bot.propose's typed-confirm approval). A second generic card would ask twice, so
 * for these the guard's `needs_approval` passes and the handler decides; denies still deny. A tainted conversation (read web content)
 * is therefore enforced inside agent.spawn (agentExecutor `isTaintedOwner`); channel.bot.propose always needs a human-approved ledger card. Their receipts
 * still carry the card's ledger `approvalStatus` (toolExec.ts), so an expired/rejected card is never reported as waiting.
 */
const OWN_APPROVAL_TOOLS: ReadonlySet<string> = new Set(['agent.spawn', 'channel.bot.propose'])
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

/** Role of a conversation (null = ordinary Central chat or unknown id) and the skill a skill-author chat edits. */
function roleOf(db: Database, conversationId: string): { mode: ConversationMode | null; skillTarget: string | null } {
  const row = getRow(db, 'SELECT mode, skill_target FROM central_conversation WHERE id = ?', conversationId)
  return { mode: isConversationMode(row?.mode) ? row.mode : null, skillTarget: typeof row?.skill_target === 'string' ? row.skill_target : null }
}

/** A mode-locked chat has no projects: the server picks the board for `browser_read`, so the model never sees `projectId`. */
function withoutProject(input: CapabilitySpec['input']): Record<string, unknown> {
  const { projectId: _unused, ...properties } = (input?.properties ?? {}) as Record<string, unknown>
  return { ...input, properties, required: (input?.required ?? []).filter((k: string) => k !== 'projectId') }
}

/** `tools/list` for Central: schema straight from the registry, tier in the description; a mode-locked conversation sees only its own tools. */
export function listCentralTools(c: Pick<CentralMcpDeps, 'registry' | 'env'> & { db?: Database }, conversationId?: string): McpTool[] {
  const mode = c.db && conversationId ? roleOf(c.db, conversationId).mode : null
  return [...centralCapabilities(c)].filter(([, cap]) => modeAllowsTool(mode, cap.name)).map(([name, cap]) => ({
    name,
    description: `${cap.summary} (webterm ${cap.name}, tier ${cap.tier}${cap.tier >= 'R2' ? ', needs human approval unless the level allows it' : ''})`,
    inputSchema: (mode && cap.name === WEB_READ_TOOL ? withoutProject(cap.input) : { ...(cap.input ?? { type: 'object' }) }) as Record<string, unknown>,
    annotations: { readOnlyHint: cap.tier === 'R0', destructiveHint: !!cap.destructive, idempotentHint: !!cap.idempotent },
  }))
}

/** Why a skill-author proposal is refused (no explicit kind, a non-central kind, or another skill than the one this chat edits); null when fine. A kind change of an existing skill is refused by the store (`audience_immutable`). */
function skillAuthorViolation(db: Database, args: Record<string, unknown>, target: string | null): string | null {
  // A built-in target is a read-only reference (the "variant" flow): the proposal must be a NEW skill under another name.
  const builtin = target !== null && getRow(db, "SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'central_skill'") !== null
    && getRow(db, "SELECT 1 AS n FROM central_skill WHERE name = ? AND origin = 'builtin'", target) !== null
  if (target !== null && (builtin ? args.name === target : args.name !== target)) return 'skill_not_target'
  if (!isSkillAudience(args.audience)) return 'audience_required'
  // Central's author writes Central skills only; canvas skills are written from the Skills panel on the canvas.
  if (args.audience !== 'central') return 'audience_not_allowed_in_mode'
  return null
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
function approvalRequest(conversationId: string, tool: string, args: Record<string, unknown>, tainted = false): Record<string, unknown> {
  // `title` leads so the inbox summary shows the reason first; it names no page, origin or summary (Rule 12).
  return { ...(tainted ? { title: `Run ${tool}: ${TAINT_REASON}` } : {}), tool, conversationId, input: redactValue(args), inputDigest: approvalDigest(args) }
}

const pendingReceipt = (approvalId: string, expiresAt: number | null): McpReceipt => receipt('denied', 'approval_required', { approvalId, status: APPROVAL_PENDING, expiresAt },
  'an approval card is shown in the Central chat; tell the human what it asks, then call the same tool with the same input again after they approve',
  { approvalId, approvalStatus: APPROVAL_PENDING })

async function exec(c: CentralMcpDeps, conversationId: string, tool: string, args: Record<string, unknown>, approved: boolean): Promise<{ receipt: McpReceipt; projectId?: string; ownCard: boolean }> {
  const guard = toToolGuard(c.guard, { approved })
  const turnId = getRow(c.db, 'SELECT active_turn_id FROM central_conversation WHERE id = ?', conversationId)?.active_turn_id
  const ctx = { db: c.db, registry: c.registry, guard, maxTier: 'R3' as const, conversationId, ...(typeof turnId === 'string' ? { turnId } : {}), now: c.now ?? Date.now, env: c.env }
  const { receipt: r, result } = await execToolReceipt(ctx, tool, args)
  const ownCard = typeof (result?.data as { approvalId?: unknown } | undefined)?.approvalId === 'string'
  return { receipt: { ...r, data: result?.data ?? null }, ...(result?.projectId ? { projectId: result.projectId } : {}), ownCard }
}

/** Runs one Central MCP call; never throws for a bad call. */
export async function callCentralTool(c: CentralMcpDeps, conversationId: string, name: string, raw: Record<string, unknown>): Promise<McpReceipt> {
  const cap = centralCapabilities(c).get(name)
  if (!cap) return receipt('error', 'unknown_tool', null, 'tools/list or cap_search shows the tools that exist')
  // A mode-locked conversation (skill author) may only call its own tools: refused before anything else reads the input.
  const role = roleOf(c.db, conversationId)
  if (!modeAllowsTool(role.mode, cap.name)) return receipt('denied', 'tool_not_allowed_in_mode', null, `this chat is the ${role.mode}; it has no ${cap.name}. Tell the human what you cannot do here`)
  // Scrubbed first, so the guard, approval digest, receipts and every store see only redacted input (K7-F1).
  let args = redactToolArgs(cap.name, raw, c.secretValues ?? (() => brokerSecretValues()))
  if (role.mode && cap.name === WEB_READ_TOOL) {
    const picked = authorWebReadArgs(c.db, args)
    if (!picked) return receipt('denied', 'no_project_for_web_read', null, 'tell the human web reading needs a project on the board; offer to continue from pasted text')
    args = picked
  }
  const violation = cap.input ? checkSchema(cap.input, args) : null
  if (violation !== null) return receipt('error', 'invalid_shape', null, 'tools/list shows the exact input schema', { violation })
  const tool = cap.name
  if (role.mode && tool === WEB_READ_TOOL) {
    const notPublic = authorWebReadViolation(args)
    if (notPublic) return receipt('denied', notPublic, null, 'only public http(s) pages can be read; ask the human to paste the text instead')
  }
  // The kind is explicit and must be central in this mode; a missing, unknown or canvas kind is refused here, after the redaction above (the other-tool denial is earlier).
  if (role.mode && tool === 'skill.propose') {
    const denied = skillAuthorViolation(c.db, args, role.skillTarget)
    if (denied) return receipt('denied', denied, null, denied === 'audience_not_allowed_in_mode' ? 'canvas skills are written from the Skills panel on the canvas' : 'propose with audience central' + (role.skillTarget ? ` and only the skill named ${role.skillTarget} (for a built-in reference: a new name)` : ''))
  }
  if (OWN_APPROVAL_TOOLS.has(tool)) return (await exec(c, conversationId, tool, args, true)).receipt

  const now = (c.now ?? Date.now)()
  const base = approvalBase(conversationId, tool, args)
  const cards = approvalsOf(c.db, base)
  const latest = cards[0]
  const expired = latest !== undefined && latest.status === 'pending' && latest.expiresAt !== null && latest.expiresAt <= now
  if (latest && !expired) {
    if (latest.status === 'pending' && !c.guard.skipsApprovals(typeof args.projectId === 'string' ? args.projectId : null)) return pendingReceipt(latest.id, latest.expiresAt)
    if (latest.status === 'rejected') return receipt('denied', 'approval_rejected', { approvalId: latest.id }, 'the human rejected this exact call; do not retry it', { approvalId: latest.id, approvalStatus: 'rejected' })
    if (latest.status === 'approved' && latest.unused) {
      // The card was digested with or without the taint title, whichever it was raised under; a mismatch consumes nothing.
      const consume = (tainted: boolean): boolean => consumeApproval({ db: c.db, now: () => now }, latest.id, { digest: approvalDigest(approvalRequest(conversationId, tool, args, tainted)) })
      // Single use: a concurrent poll that lost the race sees false and must not run the tool again.
      if (!consume(false) && !consume(true)) return receipt('denied', 'approval_used', { approvalId: latest.id }, null, { approvalId: latest.id, approvalStatus: 'approved' })
      const ran = await exec(c, conversationId, tool, args, true)
      return { ...ran.receipt, evidence: { ...ran.receipt.evidence, approvalId: latest.id, approvalStatus: 'approved' } }
    }
  }
  const first = await exec(c, conversationId, tool, args, false)
  if (first.receipt.detail !== 'approval_required' || first.ownCard) return first.receipt
  // The ledger keys every card to a project; a global tool that needs approval cannot get one here.
  if (!first.projectId) return receipt('denied', 'approval_needs_project', null, 'ask the human to run this from the webterm UI')
  const id = cards.length === 0 ? base : `${base}-${cards.length + 1}`
  const challenge = requestApproval({ db: c.db, now: () => now }, { id, projectId: first.projectId, kind: tool, request: approvalRequest(conversationId, tool, args, wasTaintedAsk(conversationId, tool, now)) })
  return pendingReceipt(challenge.id, challenge.expiresAt)
}
