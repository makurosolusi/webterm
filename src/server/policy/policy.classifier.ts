// Middle-tier classifier for gated actions (PLAN F4-d, rnd/04 #9). An action that would otherwise wait for a
// human may be approved by a second, small model instead, and only then; everything else still asks.
//
// Imitated design: Claude Code auto mode (code.claude.com/docs/en/permission-modes). "The classifier sees ...
// tool calls ... Tool results are stripped from those requests, so hostile content in a file or web page can't
// manipulate the classifier directly"; explicit ask rules "still force a prompt"; some actions are auto-approved
// in no mode (critical-path rm, writes to protected paths such as .git/.claude/.bashrc); and "No verdict from the
// classifier" blocks. Here: the input is capability + tier + redacted args + workspace ids, never page, file,
// transcript or memory text; a hard never-auto list always asks; any failure asks. Default OFF (switch below).
import type { Database } from 'bun:sqlite'
import type { AppendEventInput } from '../events/eventModel'
import { getRow } from '../ledger/ledgerCore'
import { readCentralSetting, writeCentralSetting } from '../central/centralSetting'
import type { Tier } from '../central/contracts/level.types'
import { redactValue } from '../redactSecrets'

export const CLASSIFIER_EVENT = 'policy.classifier'
export const CLASSIFIER_SWITCH_EVENT = 'policy.classifier_switch'
/** `approved_by` of a card the classifier approved, and the event actor. */
export const CLASSIFIER_ACTOR = 'classifier'
export const CLASSIFIER_TIMEOUT_MS = 30_000
const REASON_MAX = 200
const ARG_STRING_MAX = 300
const ARG_DEPTH_MAX = 3

/** What the classifier is allowed to see. Nothing else is ever passed to it. */
export interface ClassifierInput {
  capability: string
  tier: Tier
  args: Record<string, unknown>
  workspace: { cwd: string | null; projectId: string | null; workspaceId: string | null }
}
export interface ClassifierVerdict { decision: 'allow' | 'ask'; reason: string }
/** Port to the model; tests inject a fake, production uses `createClaudeClassifier`. */
export type Classifier = (input: ClassifierInput, signal: AbortSignal) => Promise<ClassifierVerdict>

/** A gated action as the caller knows it; `args` is raw and is sanitised here. */
export interface GatedAction {
  principal: string
  capability: string
  tier: Tier
  args: unknown
  destructive?: boolean
  /** The call is tainted by untrusted (web/browser/third-party) content: never classified. */
  untrusted?: boolean
  /** A human `ask` rule matched: Claude Code keeps those prompts in every mode. */
  askRule?: boolean
  cwd?: string | null
  projectId?: string | null
  workspaceId?: string | null
  nodeId?: string | null
  approvalId?: string
}

export type GatedBy = 'classifier' | 'never_auto' | 'untrusted' | 'failure'
export interface GatedOutcome { effect: 'allow' | 'ask'; reason: string; by: GatedBy }

/** Capabilities that change rules, levels, grants or secrets: never auto. */
const RULE_CAP = /^(policy|grant|grants|permission|secret|secrets|control|level)([.:]|$)|\.(grant|revoke|delete|remove|destroy|purge)$/i
const PUSH = /\bgit\s+push\b|\b(npm|bun|pnpm|yarn)\s+publish\b|\bdocker\s+push\b/i
const DELETE_BRANCH = /\bgit\s+branch\s+(-[a-zA-Z]*[dD]\b|--delete\b)|\bgit\s+push\b[^\n]*(--delete\b|\s:\S)/i
const DESTRUCTIVE_CMD = /(^|[\s;&|(])(rm|rmdir|shred|mkfs\S*|dd)\s|\bgit\s+(reset\s+--hard|clean\s+-|checkout\s+--\s|restore\b|stash\s+(drop|clear)|filter-branch|rebase\b)|\bsudo\b|\bchmod\s+-R\b|\bchown\s+-R\b|(curl|wget)[^|]*\|\s*(ba|z|da)?sh\b|>\s*\/dev\/(sd|disk)/i
const SECRET = /(^|[\s/'"=])\.env(\.|\b|$)|\.(pem|key|p12|pfx|keystore)\b|id_(rsa|ed25519|ecdsa)|credentials|service-account|\.(aws|ssh|gnupg|gcp)\/|\b(secret|password|passwd|api[_-]?key|token)s?\b/i
/** Claude Code protected paths (permission-modes "Protected paths"). */
const PROTECTED = /(^|[/\s'"])\.(git|claude|vscode|idea)(\/|\s|$|['"])|\.(gitconfig|bashrc|zshrc|profile|npmrc|mcp\.json|claude\.json)\b/i
const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'cwd', 'dir', 'directory', 'target']
/** Free-text keys that may carry web/file/memory content: replaced by a length marker, never sent. */
const CONTENT_KEYS = /^(content|contents|text|body|html|markdown|snapshot|page|dom|memory|memories|note|notes|value|prompt|message|messages|old_string|new_string|edits|new_source|transcript|output|result|data)$/i

/** Every string of `v` except under content keys (file bodies are not commands; they never reach the model either). */
const strings = (v: unknown, depth = 0): string[] => {
  if (typeof v === 'string') return [v]
  if (!v || typeof v !== 'object' || depth > ARG_DEPTH_MAX) return []
  if (Array.isArray(v)) return v.flatMap((x) => strings(x, depth + 1))
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => (CONTENT_KEYS.test(k) ? [] : strings(x, depth + 1)))
}

/** True when `p` leaves `cwd` (or `cwd` is unknown and `p` is absolute/home-relative). */
export function outsideCwd(p: string, cwd: string | null | undefined): boolean {
  if (/(^|[/\\])\.\.([/\\]|$)/.test(p) || p.startsWith('~')) return true
  if (!p.startsWith('/')) return false
  if (!cwd) return true
  const root = cwd.replace(/\/+$/, '')
  return p !== root && !p.startsWith(`${root}/`)
}

/** Why `a` must always go to a human, or null when the classifier may look at it. Pure. */
export function neverAutoReason(a: Pick<GatedAction, 'capability' | 'tier' | 'args' | 'destructive' | 'askRule' | 'cwd'>): string | null {
  if (a.destructive) return 'destructive capability'
  if (a.tier === 'R3') return 'R3 action'
  if (a.askRule) return 'an explicit ask rule matches'
  if (RULE_CAP.test(a.capability)) return 'policy, grant, level or secret change'
  const text = strings(a.args).join('\n')
  if (DELETE_BRANCH.test(text)) return 'deletes a branch'
  if (PUSH.test(text)) return 'pushes or publishes'
  if (DESTRUCTIVE_CMD.test(text)) return 'destructive command'
  if (SECRET.test(text)) return 'touches secrets or credentials'
  if (PROTECTED.test(text)) return 'writes a protected path'
  const args = (a.args && typeof a.args === 'object' ? a.args : {}) as Record<string, unknown>
  for (const k of PATH_KEYS) {
    const v = args[k]
    if (typeof v === 'string' && outsideCwd(v, a.cwd)) return 'path outside the working directory'
  }
  if (/(^|[\s;&|])cd\s+(\/|~|\.\.)/.test(text)) return 'leaves the working directory'
  return null
}

function sanitize(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return v.length > ARG_STRING_MAX ? `${v.slice(0, ARG_STRING_MAX)}…` : v
  if (v === null || typeof v !== 'object') return v
  if (depth >= ARG_DEPTH_MAX) return '[nested]'
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => sanitize(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v).slice(0, 30)) {
    out[k] = CONTENT_KEYS.test(k) ? `[omitted: ${typeof x === 'string' ? x.length : JSON.stringify(x ?? null).length} chars]` : sanitize(x, depth + 1)
  }
  return out
}

/** The only constructor of a `ClassifierInput`: secrets redacted, content keys dropped, strings capped. */
export function classifierInput(a: GatedAction): ClassifierInput {
  const args = sanitize(redactValue(a.args ?? {}), 0)
  return {
    capability: a.capability.slice(0, 128), tier: a.tier,
    args: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : { value: args },
    workspace: { cwd: a.cwd ?? null, projectId: a.projectId ?? null, workspaceId: a.workspaceId ?? null },
  }
}

const isVerdict = (v: unknown): v is ClassifierVerdict =>
  !!v && typeof v === 'object' && ((v as ClassifierVerdict).decision === 'allow' || (v as ClassifierVerdict).decision === 'ask')
  && typeof (v as ClassifierVerdict).reason === 'string'

export interface ClassifyDeps {
  classifier: Classifier
  record: (e: AppendEventInput) => void
  timeoutMs?: number
  now?: () => number
}

/** never-auto -> untrusted -> classifier (bounded by `timeoutMs`); every path except allow asks. Logged. */
export async function classifyGated(deps: ClassifyDeps, a: GatedAction): Promise<GatedOutcome> {
  const now = deps.now ?? Date.now
  const started = now()
  const finish = (o: GatedOutcome): GatedOutcome => {
    const out = { ...o, reason: o.reason.replace(/\s+/g, ' ').slice(0, REASON_MAX) }
    deps.record({
      kind: CLASSIFIER_EVENT, source: 'policy', actor: CLASSIFIER_ACTOR, trust: 'trusted',
      subject: a.approvalId ? `approval:${a.approvalId}` : null, workspaceId: a.workspaceId ?? null, nodeId: a.nodeId ?? null,
      payload: { principal: a.principal, capability: a.capability, tier: a.tier, effect: out.effect, by: out.by, reason: out.reason, ms: now() - started, ...(a.approvalId ? { approvalId: a.approvalId } : {}) },
    })
    return out
  }
  const never = neverAutoReason(a)
  if (never) return finish({ effect: 'ask', by: 'never_auto', reason: never })
  if (a.untrusted) return finish({ effect: 'ask', by: 'untrusted', reason: 'input is tainted by untrusted content' })
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new Error('classifier timed out')) }, deps.timeoutMs ?? CLASSIFIER_TIMEOUT_MS) })
    const v = await Promise.race([deps.classifier(classifierInput(a), ctl.signal), timeout])
    if (!isVerdict(v)) return finish({ effect: 'ask', by: 'failure', reason: 'classifier returned no verdict' })
    return finish({ effect: v.decision, by: 'classifier', reason: v.reason || 'no reason given' })
  } catch (err) {
    return finish({ effect: 'ask', by: 'failure', reason: `classifier failed: ${err instanceof Error ? err.message : String(err)}` })
  } finally {
    clearTimeout(timer)
  }
}

/** Global switch: `central` = Central's gated tools, `permissions` = Claude Code permission prompts. */
export interface ClassifierSwitch { central: boolean; permissions: boolean }
export const CLASSIFIER_OFF: ClassifierSwitch = { central: false, permissions: false }
const switchCache = new WeakMap<Database, ClassifierSwitch>()

/** `central_control` setting holding the switch (v33): configuration, never pruned like the event log. */
export const CLASSIFIER_SWITCH_SETTING = 'classifier_switch'
const asSwitch = (p: Partial<ClassifierSwitch>): ClassifierSwitch => ({ central: p.central === true, permissions: p.permissions === true })

/** Current switch; OFF until a human turns it on. Old installs that only have the event row fall back to it. */
export function classifierSwitch(db: Database): ClassifierSwitch {
  const hit = switchCache.get(db)
  if (hit) return hit
  const stored = readCentralSetting(db, CLASSIFIER_SWITCH_SETTING)
  let s = CLASSIFIER_OFF
  if (stored && typeof stored === 'object') s = asSwitch(stored as Partial<ClassifierSwitch>)
  else {
    const row = getRow(db, 'SELECT payload_json FROM event WHERE kind = ? ORDER BY seq DESC LIMIT 1', CLASSIFIER_SWITCH_EVENT)
    if (row) s = asSwitch(JSON.parse(String(row['payload_json'])) as Partial<ClassifierSwitch>)
  }
  switchCache.set(db, s)
  return s
}

/** Writes the switch (callers gate this to the human UI). */
export function setClassifierSwitch(db: Database, record: (e: AppendEventInput) => void, next: ClassifierSwitch, actor = 'human-ui'): ClassifierSwitch {
  const s = asSwitch(next)
  writeCentralSetting(db, CLASSIFIER_SWITCH_SETTING, s, actor, Date.now())
  record({ kind: CLASSIFIER_SWITCH_EVENT, source: 'policy', actor, trust: 'trusted', payload: s })
  switchCache.set(db, s)
  return s
}
