// Server side of `webterm mcp`: which registry capabilities a node sees as MCP tools, and how a call
// runs. Every call is decided by the policy engine for the proven principal `node:<id>`, answered with
// a receipt, and audited as an `mcp.call` event. Deps are injected so the gate is testable without boot.
import { resolve, sep } from 'node:path'
import type { Database } from 'bun:sqlite'
import { BROWSER_CONTROL_PREFIX } from '../../shared/browser.contract'
import type { Workspace } from '../../shared/workspace'
import { TOKEN_HEADER } from '../auth'
import type { CapabilitySpec } from '../capability/capability.define'
import { registryIndex } from '../capability/capability.index'
import type { Receipt } from '../capability/capability.receipt'
import { checkSchema } from '../capability/capability.schema'
import { GLOBAL_CONVERSATION_ID } from '../central/conversationModel'
import type { SyncControlGuard } from '../central/guard/controlGuard'
import { brokerSecretValues, maskValue } from '../central/runtime/runtimeEvents'
import { toolCapability } from '../central/tools/toolCapability'
import { execToolReceipt } from '../central/tools/toolExec'
import { type ToolRegistry, defEnabled } from '../central/tools/toolTypes'
import { findWorkspaceFor } from '../contextLinkRoute'
import type { ControlRequest, ControlResult } from '../control/controlTypes'
import type { EventLog } from '../events/eventLog'
import { cableGrants } from '../policy/policy.cable'
import type { Policy } from '../policy/policy.decide'
import type { Grant } from '../policy/policy.model'
import { BOT_APPROVAL_ACTION, BOT_SECRET_INPUTS } from '../central/tools/defs/channel.bot.def'
import { runSecretCapability, type BrokerDeps } from '../secrets/secret.broker'
import { isSecretCapability, SECRET_CAPABILITIES } from '../secrets/secret.capabilities'
import { repoRootOf } from '../gitDiff'
import { cachedToolRead } from '../toolcache/toolCache'
import { gitTreeVersion } from '../toolcache/toolCacheGit'
import type { McpTool } from './mcp.protocol'

type Env = Record<string, string | undefined>

export interface McpDeps {
  /** Null = ledger off: no rules, so every call is refused (fail closed). */
  policy: Pick<Policy, 'decide'> | null
  workspaces(): readonly Workspace[]
  /** Central tool registry and the ledger it runs on; null while Central is off. */
  central: { db: Database; registry: ToolRegistry; env: Env; guard?: SyncControlGuard } | null
  /** Capability-token lookup; only a record minted for Central's MCP child opens the `central` mode (mcp.central.ts). */
  capability?: (token: string) => { mintedBy?: string } | undefined
  /** Browser control handler (`activeBrowser().control`); null while the browser runtime is off. */
  browser: ((req: ControlRequest) => Promise<ControlResult>) | null
  gitDiff(query: URLSearchParams): Promise<ControlResult>
  events: Pick<EventLog, 'append'> | null
  /** Secret broker store/usage overrides (tests); absent = the real broker store in the data dir. */
  secrets?: Pick<BrokerDeps, 'store' | 'lastUsed'>
}

/** Route capabilities with an MCP executor. Control verbs node.*, approval.*, plan.read stay
 *  capability-token only (minted for Central/orchestrator), so a node never sees them here. */
const ROUTE_TOOLS = new Set(['browser.read', 'browser.act', 'git.diff', 'secret.run', 'secret.list'])
/** Central's project-scoped wrappers of the browser verbs; nodes use the cable-gated browser.* above. */
const SUPERSEDED = new Set(['browser_status', 'browser_act'])

/** MCP tool name: dots become underscores (Anthropic/OpenAI tool names allow `[A-Za-z0-9_-]` only). */
export const mcpName = (capability: string): string => capability.replace(/\./g, '_')

/** Capabilities a node sees, keyed by MCP name; throws if two names collapse to one. */
export function nodeCapabilities(deps: Pick<McpDeps, 'central'>): Map<string, CapabilitySpec> {
  const c = deps.central
  const central = c ? c.registry.list().filter((d) => defEnabled(d, c.env) && !SUPERSEDED.has(d.name)).map(toolCapability) : []
  const out = new Map<string, CapabilitySpec>()
  for (const cap of registryIndex([...SECRET_CAPABILITIES, ...central]).list()) {
    if (!cap.projections.includes('central') && !ROUTE_TOOLS.has(cap.name)) continue
    const name = mcpName(cap.name)
    if (out.has(name)) throw new Error(`mcp tool name ${name} is claimed by two capabilities`)
    out.set(name, cap)
  }
  return out
}

/** MCP `tools/list` entries: schema straight from the registry, tier in the description. */
export function listTools(deps: Pick<McpDeps, 'central'>): McpTool[] {
  return [...nodeCapabilities(deps)].map(([name, cap]) => ({
    name,
    description: `${cap.summary} (webterm ${cap.name}, tier ${cap.tier})`,
    inputSchema: { ...(cap.input ?? { type: 'object' }) } as Record<string, unknown>,
    annotations: { readOnlyHint: cap.tier === 'R0', destructiveHint: !!cap.destructive, idempotentHint: !!cap.idempotent },
  }))
}

/** Input fields allowed to carry a raw secret, per capability; every other string an agent sends is scrubbed. */
const SECRET_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = { [BOT_APPROVAL_ACTION]: BOT_SECRET_INPUTS }

/**
 * `args` with every string scrubbed of credential shapes and broker-held values (raw + encoded forms),
 * before validation, receipts or persistence (K7-F1: a model must not launder a secret into a goal, plan,
 * memory or task). `secret.*` takes names, never values, and passes untouched, as do declared secret fields.
 */
export function redactToolArgs(capability: string, args: Record<string, unknown>, known: () => readonly string[]): Record<string, unknown> {
  if (isSecretCapability(capability)) return args
  const keep = SECRET_INPUT_FIELDS[capability] ?? []
  const values = known()
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, keep.includes(k) ? v : maskValue(v, values)]))
}

export type McpReceipt = Receipt & { data: unknown }
const receipt = (outcome: Receipt['outcome'], detail: string, data: unknown = null, next: string | null = null): McpReceipt =>
  ({ outcome, detail, next, evidence: {}, operationId: null, data })

/**
 * Reads are open to every node (builtin `node:*` is deny-all): an R0 capability that does not target
 * another node gets an allow grant in the cable slot, so a human rule written later still wins
 * (last match). Node-scoped reads (browser.read) need a real cable.
 */
function readGrants(principal: string, cap: CapabilitySpec): Grant[] {
  if (cap.tier !== 'R0' || cap.scope === 'node') return []
  return [{ id: `mcp-read:${cap.name}`, subject: principal, capability: cap.name, scope: '*', effect: 'allow', expiresAt: null, origin: 'builtin', createdBy: 'human-ui', createdAt: 0 }]
}

function decide(deps: McpDeps, principal: string, cap: CapabilitySpec, resource: string | undefined, cable: Grant[] = []): Receipt | null {
  if (!deps.policy) return receipt('denied', 'policy_unavailable', null, 'the webterm ledger is off; only the user can turn it on')
  const d = deps.policy.decide(principal, cap.name, { ...(resource ? { resource } : {}), cable: [...cable, ...readGrants(principal, cap)] })
  if (d.effect === 'allow') return null
  return { ...receipt('denied', d.effect === 'ask' ? 'approval_required' : 'policy_denied', null, 'only the user can change this rule; do not retry'), evidence: { reason: d.reason } }
}

const fromHttp = (res: ControlResult): McpReceipt => {
  if (!res) return receipt('error', 'not_found')
  const body = res.body as Record<string, unknown> | undefined
  if (res.status < 400) return receipt('ok', 'ok', body ?? null)
  const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`
  return { ...receipt(res.status === 403 ? 'denied' : 'error', code, null), evidence: { status: res.status, ...(typeof body?.message === 'string' ? { message: body.message } : {}) } }
}

async function runBrowser(deps: McpDeps, nodeId: string, token: string, cap: CapabilitySpec, args: Record<string, unknown>): Promise<McpReceipt> {
  const { nodeId: target, verb, ...body } = args
  const cable = cableGrants(deps.workspaces(), nodeId)
  const resource = typeof target === 'string' ? `node:${target}` : cable.length === 1 ? cable[0].scope : undefined
  const denied = decide(deps, `node:${nodeId}`, cap, resource, cable)
  if (denied) return { ...denied, data: null }
  if (!deps.browser) return receipt('error', 'browser_off', null, 'the browser feature is off; only the user can turn it on')
  const path = `${BROWSER_CONTROL_PREFIX}/${typeof target === 'string' ? `${target}/` : ''}${String(verb)}`
  return fromHttp(await deps.browser({ method: 'POST', path, headers: { [TOKEN_HEADER]: token }, body }))
}

async function runGitDiff(deps: McpDeps, nodeId: string, cap: CapabilitySpec, args: Record<string, unknown>): Promise<McpReceipt> {
  const denied = decide(deps, `node:${nodeId}`, cap, undefined)
  if (denied) return { ...denied, data: null }
  // A node reads diffs of its own folder only: the root must sit inside the node (or board) cwd.
  const ws = findWorkspaceFor(deps.workspaces() as Workspace[], nodeId)
  const cwd = ws?.nodes.find((n) => n.id === nodeId)?.cwd ?? ws?.cwd
  if (!cwd) return receipt('denied', 'no_cwd', null, 'this node has no working folder on the canvas')
  const root = resolve(cwd, String(args.root))
  if (root !== resolve(cwd) && !root.startsWith(resolve(cwd) + sep)) return receipt('denied', 'outside_cwd', null, 'pass a root inside this node working folder')
  const q = new URLSearchParams({ root })
  for (const k of ['path', 'offset', 'limit'] as const) if (args[k] !== undefined) q.set(k, String(args[k]))
  const db = deps.central?.db
  // Not a repo (or no ledger): no version to key on, so no cache; the diff route answers the error itself.
  const version = db ? await repoRootOf(root).then(gitTreeVersion, () => null) : null
  if (!db || version === null) return fromHttp(await deps.gitDiff(q))
  const { value } = await cachedToolRead(db, { tool: 'git.diff', args: Object.fromEntries(q), version }, () => deps.gitDiff(q), Date.now(),
    (res) => !!res && res.status < 400)
  return fromHttp(value)
}

async function run(deps: McpDeps, nodeId: string, token: string, cap: CapabilitySpec, args: Record<string, unknown>): Promise<McpReceipt> {
  const principal = `node:${nodeId}`
  if (cap.name === 'browser.read' || cap.name === 'browser.act') return runBrowser(deps, nodeId, token, cap, args)
  if (cap.name === 'git.diff') return runGitDiff(deps, nodeId, cap, args)
  if (isSecretCapability(cap.name)) {
    // Same broker as `/api/tools/secret.*`: it decides per secret (ask by default), runs, masks, records secret.use.
    const broker: BrokerDeps = { policy: () => deps.policy, workspaces: deps.workspaces, events: () => deps.events, ...deps.secrets }
    const { receipt: r, data } = await runSecretCapability(broker, cap.name, args, principal)
    return { ...r, data: data ?? null }
  }
  const c = deps.central
  if (!c) return receipt('error', 'central_off')
  const guard = { check: () => (decide(deps, principal, cap, typeof args.projectId === 'string' ? `project:${args.projectId}` : undefined) ? { ok: false as const, code: 'policy_denied' } : { ok: true as const }) }
  const ctx = { db: c.db, registry: c.registry, guard, maxTier: 'R3' as const, conversationId: GLOBAL_CONVERSATION_ID, now: Date.now, env: c.env }
  const { receipt: r, result } = await execToolReceipt(ctx, cap.name, args)
  return { ...r, data: result?.data ?? null }
}

/** Runs one MCP `tools/call` for the proven node and audits it; never throws for a bad call. */
export async function callTool(deps: McpDeps, nodeId: string, token: string, name: string, raw: Record<string, unknown>): Promise<McpReceipt> {
  const cap = nodeCapabilities(deps).get(name)
  const args = cap ? redactToolArgs(cap.name, raw, () => brokerSecretValues(deps.secrets?.store)) : raw
  let out: McpReceipt
  if (!cap) out = receipt('error', 'unknown_tool', null, 'tools/list or cap_search shows the tools that exist')
  else if (cap.input && checkSchema(cap.input, args) !== null) out = { ...receipt('error', 'invalid_shape', null, 'tools/list shows the exact input schema'), evidence: { violation: checkSchema(cap.input, args) } }
  else out = await run(deps, nodeId, token, cap, args)
  const ws = findWorkspaceFor(deps.workspaces() as Workspace[], nodeId)
  const seq = deps.events?.append({
    kind: 'mcp.call', source: 'mcp', actor: `node:${nodeId}`, trust: 'trusted', subject: cap?.name ?? null,
    workspaceId: ws?.id ?? null, nodeId, payload: { tool: cap?.name ?? null, outcome: out.outcome, detail: out.detail },
  }).event.seq
  return { ...out, evidence: { ...out.evidence, tool: cap?.name ?? name, ...(seq !== undefined ? { mcpSeq: seq } : {}) } }
}
