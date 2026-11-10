// Read-side views for the Central Agent v2 control panel (WS-19). Shapes mirror the client contract in
// `src/client/central/centralControlApi.ts`; every text field leaves through `redactSecrets` and is clipped.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { boundedInteger } from '../apiShared.params'
import type { RouteResult } from '../apiShared.types'
import { allRows } from '../ledger/ledgerCore'
import { redactSecrets } from '../redactSecrets'
import type { Ca2Handle } from './ca2Boot'
import { budgetLimits, readBudget, utcDay } from './guard/budgetStore'
import { lineDiff } from './ca2Routes.diff'
import { SKILL_FILE, skillDir } from './skills/skillIndex'
import { lintSkill } from './skills/skillLint'
import { confirmPhrase } from './skills/skillLifecycle'
import type { SkillRecord, SkillStatus } from './contracts/skill.types'
import { AGENT_TERMINAL_STATES } from './contracts/agent.types'
import { listWorkspaces } from './workspaceLookup'

/** A feature that is switched off answers 503 `<feature>_off`, like `ledger_off` / `central_off`. */
export const FEATURE_OFF = 503
const DEFAULT_PAGE = 50
const MAX_PAGE = 200
const MAX_OFFSET = 1_000_000
const MAX_TEXT = 400
/** Turns inspected for one still running; concurrent chats are few, so an active one is always among these. */
const RECENT_TURNS = 20
const MODEL_ENV = 'WEBTERM_CENTRAL_MODEL'
/** Free-tier model ids (P12): shown with a privacy label in the panel. */
const FREE_MODEL = /(^|[/:-])free($|[/:-])/i
const REVIEW_STATUSES: readonly SkillStatus[] = ['pending_approval', 'evaluated', 'proposed', 'active', 'rejected']

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
  return { status: 200, body: { day, used: { tokens: used.tokens, spawns: used.spawns }, limits: { tokens: limits.tokens, spawns: limits.spawns }, model: { id: model, free: FREE_MODEL.test(model) }, toolsHash: h.toolsHash, lastTurn: lastTurn(h) } }
}

/** Newest turn, preferring one still active: another chat can have a newer finished turn while this one works. */
function lastTurn(h: Ca2Handle): { at: number; status: string } | null {
  // rowid is insertion order and needs no sort, so this stays cheap on a table retention never trims.
  const recent = allRows(h.db, 'SELECT status, started_at, ended_at FROM central_turn ORDER BY rowid DESC LIMIT ?', RECENT_TURNS)
  const turn = recent.find((r) => r.ended_at === null) ?? recent[0]
  return turn ? { at: Number(turn.ended_at ?? turn.started_at), status: String(turn.status) } : null
}

/** Agents newest first, one query (no per-row lookups); `live=1` drops finished ones, `projectId=` narrows to one project. */
export function agentsView(h: Ca2Handle, q: URLSearchParams): RouteResult {
  if (!h.executor) return fail(FEATURE_OFF, 'agents_off')
  const page = pageOf(q)
  if (!page) return fail(400, 'invalid_page')
  const live = q.get('live') === '1'
  const projectId = q.get('projectId')?.trim()
  const where = [...(live ? [`a.state NOT IN (${AGENT_TERMINAL_STATES.map(() => '?').join(',')})`] : []), ...(projectId ? ['a.project_id = ?'] : [])]
  const rows = allRows(h.db, `SELECT a.id, a.project_id, a.node_id, a.kind, a.role, a.runner, a.state, a.owner, a.started_at, p.name AS project_name
    FROM central_agents a LEFT JOIN project p ON p.id = a.project_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.started_at DESC, a.id LIMIT ? OFFSET ?`, ...(live ? AGENT_TERMINAL_STATES : []), ...(projectId ? [projectId] : []), page.limit, page.offset)
  const onBoard = new Set((listWorkspaces() ?? []).flatMap((w) => (Array.isArray(w.nodes) ? w.nodes as Array<{ id?: unknown }> : []).map((n) => String(n.id))))
  return { status: 200, body: { items: rows.map((r) => {
    // A worker's node is `node_id`, or `c-<agentId>` when the canvas placed it before the id was recorded.
    const placed = `c-${String(r.id)}`
    const nodeId = r.node_id != null ? String(r.node_id) : onBoard.has(placed) ? placed : null
    return { id: String(r.id), projectId: String(r.project_id), kind: String(r.kind), role: String(r.role), runner: String(r.runner), state: String(r.state), owner: String(r.owner), nodeId, nodeOnBoard: nodeId !== null && onBoard.has(nodeId), startedAt: Number(r.started_at), projectName: clip(r.project_name) }
  }) } }
}

/** Visible memory (not superseded), newest first, bodies redacted and clipped. */
export function memoryView(h: Ca2Handle, q: URLSearchParams): RouteResult {
  const page = pageOf(q)
  if (!page) return fail(400, 'invalid_page')
  const rows = allRows(h.db, "SELECT id, scope, trust, kind, key, body FROM memory WHERE status != 'superseded' ORDER BY updated_at DESC, id LIMIT ? OFFSET ?", page.limit, page.offset)
  return { status: 200, body: { items: rows.map((r) => ({ id: String(r.id), scope: String(r.scope), trust: String(r.trust), kind: String(r.kind), key: clip(r.key), value: clip(r.body) })) } }
}

/** SKILL.md of a record from the folder its status keeps it in; null when the folder is gone. */
function recordText(root: string, r: SkillRecord): string | null {
  const bucket = r.status !== 'active' ? 'proposed' : r.origin === 'builtin' ? 'builtin' : 'versions'
  try { return readFileSync(join(skillDir(root, bucket, r.name, r.version), SKILL_FILE), 'utf8') } catch { return null }
}

/** SKILL.md of the version active now for `name`, or null when none is active (first proposal). */
function activeText(h: Ca2Handle, name: string): string | null {
  const active = h.skills?.load(name)
  return active ? recordText(h.skillsRoot, active.record) : null
}

/**
 * Skills awaiting review, with lint findings and a line diff against the active version (all-added when none).
 * `?status=active` answers the approved skills Central can load instead (`{name, description}`, the prompt index),
 * which the Central chat lists as `/` commands.
 */
export function skillsView(h: Ca2Handle, q: URLSearchParams): RouteResult {
  if (!h.skills) return fail(FEATURE_OFF, 'skills_off')
  if (q.get('status') === 'active') return { status: 200, body: { items: h.skills.index().map((e) => ({ name: clip(e.name), description: clip(e.description) })) } }
  const page = pageOf(q)
  if (!page) return fail(400, 'invalid_page')
  // A human reject carries no reason and drops off the list; a rejection by evaluation stays so its reason is visible.
  const records = REVIEW_STATUSES.flatMap((s) => h.skills?.list(s, { limit: page.limit, offset: page.offset }) ?? []).filter((r) => r.status !== 'rejected' || r.rejectReason)
  const archived = h.skills.list('archived', { limit: MAX_PAGE })
  const items = records.slice(0, page.limit).map((stored) => {
    const record = stored.rejectReason ? { ...stored, rejectReason: clip(stored.rejectReason) } : stored
    const text = recordText(h.skillsRoot, record)
    const lint = text === null ? null : lintSkill(text, { expectedName: record.name })
    return {
      record, diff: text === null || record.status === 'active' ? '' : redactSecrets(lineDiff(activeText(h, record.name) ?? '', text)).slice(0, MAX_TEXT * 10),
      canRollback: record.status === 'active' && record.origin !== 'builtin' && archived.some((a) => a.name === record.name && Number(a.version) < Number(record.version)),
      lint: { ok: lint?.ok ?? false, findings: lint ? lint.issues.map((i) => clip(typeof i === 'string' ? i : JSON.stringify(i))) : ['draft_missing'] },
      confirmPhrase: confirmPhrase(record.name, record.version),
    }
  })
  return { status: 200, body: { items } }
}
