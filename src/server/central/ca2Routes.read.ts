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
import type { SkillStatus } from './contracts/skill.types'

/** A feature that is switched off answers 503 `<feature>_off`, like `ledger_off` / `central_off`. */
export const FEATURE_OFF = 503
const DEFAULT_PAGE = 50
const MAX_PAGE = 200
const MAX_OFFSET = 1_000_000
const MAX_TEXT = 400
const MODEL_ENV = 'WEBTERM_CENTRAL_MODEL'
/** Free-tier model ids (P12): shown with a privacy label in the panel. */
const FREE_MODEL = /(^|[/:-])free($|[/:-])/i
const REVIEW_STATUSES: readonly SkillStatus[] = ['pending_approval', 'evaluated', 'proposed']

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
  if (!h.executor) return fail(FEATURE_OFF, 'agents_off')
  const page = pageOf(q)
  if (!page) return fail(400, 'invalid_page')
  const rows = allRows(h.db, 'SELECT id, project_id, kind, role, runner, state, owner FROM central_agents ORDER BY started_at DESC, id LIMIT ? OFFSET ?', page.limit, page.offset)
  return { status: 200, body: { items: rows.map((r) => ({ id: String(r.id), projectId: String(r.project_id), kind: String(r.kind), role: String(r.role), runner: String(r.runner), state: String(r.state), owner: String(r.owner) })) } }
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

/** SKILL.md of the version active now for `name`, or null when none is active (first proposal). */
function activeText(h: Ca2Handle, name: string): string | null {
  const active = h.skills?.load(name)
  if (!active) return null
  const bucket = active.record.origin === 'builtin' ? 'builtin' : 'versions'
  try { return readFileSync(join(skillDir(h.skillsRoot, bucket, name, active.record.version), SKILL_FILE), 'utf8') } catch { return null }
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
  const records = REVIEW_STATUSES.flatMap((s) => h.skills?.list(s, { limit: page.limit, offset: page.offset }) ?? [])
  const items = records.slice(0, page.limit).map((record) => {
    const text = draftText(h.skillsRoot, record.name, record.version)
    const lint = text === null ? null : lintSkill(text, { expectedName: record.name })
    return {
      record, diff: text === null ? '' : redactSecrets(lineDiff(activeText(h, record.name) ?? '', text)).slice(0, MAX_TEXT * 10),
      lint: { ok: lint?.ok ?? false, findings: lint ? lint.issues.map((i) => clip(typeof i === 'string' ? i : JSON.stringify(i))) : ['draft_missing'] },
      confirmPhrase: confirmPhrase(record.name, record.version),
    }
  })
  return { status: 200, body: { items } }
}
