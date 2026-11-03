// Read-side views for the Central Agent v2 control panel (WS-19). Shapes mirror the client contract in
// `src/client/central/centralControlApi.ts`; every text field leaves through `redactSecrets` and is clipped.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { boundedInteger } from '../apiShared.params'
import type { RouteResult } from '../apiShared.types'
import { allRows } from '../ledger/ledgerCore'
import { redactSecrets, redactValue, STREAM_LIMITS } from '../redactSecrets'
import type { Ca2Handle } from './ca2Boot'
import { budgetLimits, readBudget, utcDay } from './guard/budgetStore'
import { SKILL_FILE, skillDir } from './skills/skillIndex'
import { lintSkill } from './skills/skillLint'
import { confirmPhrase } from './skills/skillLifecycle'
import type { SkillStatus } from './contracts/skill.types'

const DEFAULT_PAGE = 50
const MAX_PAGE = 200
const MAX_OFFSET = 1_000_000
const MAX_TEXT = 400
const MAX_ARGS = 12
const MODEL_ENV = 'WEBTERM_CENTRAL_MODEL'
/** Free-tier model ids (P12): shown with a privacy label in the panel. */
const FREE_MODEL = /(^|[/:-])free($|[/:-])/i
const REVIEW_STATUSES: readonly SkillStatus[] = ['pending_approval', 'evaluated', 'proposed']
/** Risk tier per approval kind when the request payload does not carry one (P2/P6). */
const KIND_TIER: Readonly<Record<string, 'R2' | 'R3'>> = { 'agent.spawn': 'R2', 'task.run': 'R2', 'channel.bot.propose': 'R3', 'skill.approve': 'R3' }
const DEFAULT_TIER = 'R2'

type Row = Record<string, unknown>
const clip = (v: unknown): string => redactSecrets(String(v ?? '')).slice(0, MAX_TEXT)
const fail = (status: number, error: string): RouteResult => ({ status, body: { error } })

/** Parses `limit`/`offset`; null = invalid (caller answers 400). */
export function pageOf(q: URLSearchParams): { limit: number; offset: number } | null {
  const limit = boundedInteger(q.get('limit'), 1, MAX_PAGE)
  const offset = boundedInteger(q.get('offset'), 0, MAX_OFFSET)
  return limit === null || offset === null ? null : { limit: limit ?? DEFAULT_PAGE, offset: offset ?? 0 }
}

/** Flat budget + model view: `{day, used, limits, model}`. */
export function statusView(h: Ca2Handle): RouteResult {
  const day = utcDay(h.now())
  const used = readBudget(h.db, day, 'global')
  const limits = budgetLimits(h.env)
  const model = (h.env[MODEL_ENV] ?? '').trim()
  return { status: 200, body: { day, used: { tokens: used.tokens, spawns: used.spawns }, limits: { tokens: limits.tokens, spawns: limits.spawns }, model: { id: model, free: FREE_MODEL.test(model) }, toolsHash: h.toolsHash } }
}

/** Agents newest first, one query (no per-row lookups). */
export function agentsView(h: Ca2Handle, q: URLSearchParams): RouteResult {
  const page = pageOf(q)
  if (!page) return fail(400, 'invalid_page')
  const rows = allRows(h.db, 'SELECT id, project_id, kind, role, runner, state, owner FROM central_agents ORDER BY started_at DESC, id LIMIT ? OFFSET ?', page.limit, page.offset)
  return { status: 200, body: { items: rows.map((r) => ({ id: String(r.id), projectId: String(r.project_id), kind: String(r.kind), role: String(r.role), runner: String(r.runner), state: String(r.state), owner: String(r.owner) })) } }
}

function argsOf(payload: Row): Array<{ key: string; value: string }> {
  const safe = redactValue(payload, STREAM_LIMITS) as Row
  return Object.entries(safe).filter(([, v]) => v !== null && typeof v !== 'object').slice(0, MAX_ARGS).map(([key, value]) => ({ key: clip(key), value: clip(value) }))
}

function parsePayload(raw: unknown): Row {
  if (typeof raw !== 'string') return {}
  try {
    const v = JSON.parse(raw) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {}
  } catch {
    return {}
  }
}

/** Pending, unexpired approval cards with digest + nonce so the panel can decide through the inbox route. */
export function approvalsView(h: Ca2Handle, q: URLSearchParams): RouteResult {
  const page = pageOf(q)
  if (!page) return fail(400, 'invalid_page')
  const rows = allRows(h.db, `SELECT a.id, a.kind, a.project_id, a.expires_at, a.request_json, d.action_digest, d.nonce
    FROM approval a JOIN decision d ON d.id = a.decision_id
    WHERE a.status = 'pending' AND (a.expires_at IS NULL OR a.expires_at > ?)
    ORDER BY a.created_at ASC, a.id LIMIT ? OFFSET ?`, h.now(), page.limit, page.offset)
  const items = rows.map((r) => {
    const payload = parsePayload(r.request_json)
    const kind = String(r.kind)
    const tier = typeof payload.tier === 'string' && /^R[0-3]$/.test(payload.tier) ? payload.tier : KIND_TIER[kind] ?? DEFAULT_TIER
    const phrase = typeof payload.confirmPhrase === 'string' ? clip(payload.confirmPhrase) : ''
    return {
      id: String(r.id), tool: clip(typeof payload.tool === 'string' ? payload.tool : kind), tier,
      summary: clip(typeof payload.summary === 'string' ? payload.summary : `Approval requested: ${kind}`),
      args: argsOf(payload), digest: String(r.action_digest), nonce: String(r.nonce),
      expiresAt: r.expires_at === null ? 0 : Number(r.expires_at), projectId: String(r.project_id ?? ''),
      ...(phrase ? { confirmPhrase: phrase } : {}),
    }
  })
  return { status: 200, body: { items } }
}

/** Visible memory (not superseded), newest first, bodies redacted and clipped. */
export function memoryView(h: Ca2Handle, q: URLSearchParams): RouteResult {
  const page = pageOf(q)
  if (!page) return fail(400, 'invalid_page')
  const rows = allRows(h.db, "SELECT id, scope, trust, kind, key, body FROM memory WHERE status != 'superseded' ORDER BY updated_at DESC, id LIMIT ? OFFSET ?", page.limit, page.offset)
  return { status: 200, body: { items: rows.map((r) => ({ id: String(r.id), scope: String(r.scope), trust: String(r.trust), kind: String(r.kind), key: clip(r.key), value: clip(r.body) })) } }
}

function draftText(root: string, name: string, version: string): string | null {
  try { return readFileSync(join(skillDir(root, 'proposed', name, version), SKILL_FILE), 'utf8') } catch { return null }
}

/** Skills awaiting review, with lint findings and the clipped draft as the diff (no previous-version diff yet). */
export function skillsView(h: Ca2Handle, q: URLSearchParams): RouteResult {
  const page = pageOf(q)
  if (!page || !h.skills) return fail(h.skills ? 400 : 404, h.skills ? 'invalid_page' : 'skills_off')
  const records = REVIEW_STATUSES.flatMap((s) => h.skills?.list(s, { limit: page.limit, offset: page.offset }) ?? [])
  const items = records.slice(0, page.limit).map((record) => {
    const text = draftText(h.skillsRoot, record.name, record.version)
    const lint = text === null ? null : lintSkill(text, { expectedName: record.name })
    return {
      record, diff: text === null ? '' : redactSecrets(text).slice(0, MAX_TEXT * 10),
      lint: { ok: lint?.ok ?? false, findings: lint ? lint.issues.map((i) => clip(typeof i === 'string' ? i : JSON.stringify(i))) : ['draft_missing'] },
      confirmPhrase: confirmPhrase(record.name, record.version),
    }
  })
  return { status: 200, body: { items } }
}
