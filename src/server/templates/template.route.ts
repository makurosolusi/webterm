// HTTP for canvas templates. Not in `isNodeTokenPath`, so agent credentials never reach it; the
// writes are additionally human-UI only (`uiOnlyDenial`, as worktree workspaces): instantiate makes
// worktrees and routines, import stores untrusted input.
//   GET    /api/templates                    -> {templates}          (built-ins first)
//   GET    /api/templates/:id                -> the template JSON    (Export)
//   POST   /api/templates        {workspaceId, name, description?, includeRoutines?} -> 201 {template}  (Save as template)
//   POST   /api/templates/import {template}  -> 201 {template}       (Import; schema-checked)
//   DELETE /api/templates/:id               -> 204
//   POST   /api/templates/:id/instantiate {params, workspaceId?, name?}
//          workspaceId -> 200 {workspaceId, nodes, bridges, routines}   (the client places them on its canvas)
//          else        -> 201 {workspace, routines}                     (a new workspace, saved here)
import type { IncomingMessage } from 'node:http'
import type { RouteResult } from '../apiShared.types'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import { BodyReadError } from '../cappedRequestBody'
import type { Db } from '../db'
import type { Routine, RoutineInput } from '../routines/routineModel'
import { WorktreeError } from '../orchestrator/worktree'
import { captureTemplate } from './template.capture'
import { instantiateTemplate, type InstantiateDeps } from './template.instantiate'
import { TemplateError } from './template.model'
import type { TemplateStore } from './template.store'

export const TEMPLATES_PATH = '/api/templates'
export const TEMPLATES_BODY_MAX_BYTES = 512 * 1024
const NODE_GAP = 80

export interface TemplatesDeps extends InstantiateDeps {
  store: TemplateStore
  workspaces: Pick<Db, 'get' | 'create' | 'save' | 'delete'>
  /** Routine store over the ledger; null when the ledger is off (routines are then skipped). */
  routines: () => { list(): Routine[]; create(input: RoutineInput): unknown } | null
  worktreeRoot?: string
  isNodeToken: (token: string) => boolean
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const err = (status: number, error: string, message?: string): RouteResult => ({ status, body: { error, ...(message ? { message } : {}) } })
const STATUS: Record<TemplateError['code'], number> = { invalid_template: 400, invalid_params: 400, not_found: 404, builtin_readonly: 409 }

async function readJson(body: () => Promise<string>): Promise<{ value: Obj } | { fail: RouteResult }> {
  let raw: string
  try { raw = await body() } catch (e) {
    if (e instanceof BodyReadError) return { fail: err(e.reason === 'too_large' ? 413 : 400, e.reason) }
    throw e
  }
  try {
    const v: unknown = JSON.parse(raw)
    if (isObj(v)) return { value: v }
  } catch { /* not JSON: same 400 as a non-object below */ }
  return { fail: err(400, 'invalid_json', 'body must be a JSON object') }
}

/** Lower-case slug + a fresh-id suffix: a valid template id that does not collide. */
const slugId = (name: string, deps: TemplatesDeps): string =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'template'}-${deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`

/** null = not a templates path. */
export async function templatesRoute(req: IncomingMessage, url: URL, body: () => Promise<string>, deps: TemplatesDeps): Promise<RouteResult | { status: 204 } | null> {
  const path = url.pathname
  if (path !== TEMPLATES_PATH && !path.startsWith(`${TEMPLATES_PATH}/`)) return null
  const method = req.method ?? 'GET'
  const [rawId = '', action, extra] = path.slice(TEMPLATES_PATH.length + 1).split('/')
  let id: string
  try { id = decodeURIComponent(rawId) } catch { return err(400, 'invalid_id') }
  if (extra !== undefined || (action !== undefined && action !== 'instantiate')) return err(404, 'not_found')
  if (method === 'GET') {
    if (action) return err(405, 'method_not_allowed')
    if (!id) return { status: 200, body: { templates: deps.store.list() } }
    const t = deps.store.get(id)
    return t ? { status: 200, body: t } : err(404, 'not_found')
  }
  const denial = uiOnlyDenial(req, url, deps.isNodeToken)
  if (denial) return err(403, denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_manage_templates' : denial, 'Templates are managed by the human at the webterm UI only.')
  try {
    if (method === 'DELETE' && id && !action) {
      return deps.store.delete(id) ? { status: 204 } : err(404, 'not_found')
    }
    if (method !== 'POST') return err(405, 'method_not_allowed')
    const read = await readJson(body)
    if ('fail' in read) return read.fail
    const b = read.value
    if (!id) return saveFromWorkspace(b, deps)
    if (id === 'import' && !action) return importTemplate(b, deps)
    if (action === 'instantiate') return await instantiate(id, b, deps)
    return err(404, 'not_found')
  } catch (e) {
    if (e instanceof TemplateError) return err(STATUS[e.code], e.code, e.message)
    if (e instanceof WorktreeError) return err(400, e.code, e.message)
    throw e
  }
}

function saveFromWorkspace(b: Obj, deps: TemplatesDeps): RouteResult {
  const ws = typeof b.workspaceId === 'string' ? deps.workspaces.get(b.workspaceId) : null
  if (!ws) return err(404, 'workspace_not_found')
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 120) : ws.name
  const routines = b.includeRoutines === false ? [] : deps.routines()?.list() ?? []
  const t = captureTemplate({
    ws, id: slugId(name, deps), name, routines,
    description: typeof b.description === 'string' ? b.description.slice(0, 1000) : '',
    ...(deps.worktreeRoot ? { worktreeRoot: deps.worktreeRoot } : {}),
  })
  return { status: 201, body: { template: deps.store.put(t) } }
}

function importTemplate(b: Obj, deps: TemplatesDeps): RouteResult {
  const raw = isObj(b.template) ? b.template : b
  // An exported built-in (or a same-id file) comes back as a copy instead of a conflict.
  const clash = typeof raw.id === 'string' && deps.store.get(raw.id) !== null
  const t = deps.store.put(clash ? { ...raw, id: slugId(String(raw.name ?? raw.id), deps) } : raw)
  return { status: 201, body: { template: t } }
}

async function instantiate(id: string, b: Obj, deps: TemplatesDeps): Promise<RouteResult> {
  const t = deps.store.get(id)
  if (!t) return err(404, 'not_found')
  const existing = typeof b.workspaceId === 'string' ? deps.workspaces.get(b.workspaceId) : null
  if (typeof b.workspaceId === 'string' && !existing) return err(404, 'workspace_not_found')
  const right = existing?.nodes.reduce((m, n) => Math.max(m, n.x + (n.width ?? 0)), -Infinity) ?? -Infinity
  const offset = existing && existing.nodes.length ? { x: right + NODE_GAP, y: Math.min(...existing.nodes.map((n) => n.y)) } : { x: 0, y: 0 }
  // A new workspace is created first so plan nodes and routines bind to its id; removed again on failure.
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 120) : t.name
  const created = existing ? null : deps.workspaces.create(name)
  let m: Awaited<ReturnType<typeof instantiateTemplate>>
  try {
    m = await instantiateTemplate(t, b.params, { workspaceId: existing?.id ?? created!.id, workspaceCwd: existing?.cwd, offset }, deps)
  } catch (e) {
    if (created) deps.workspaces.delete(created.id)
    throw e
  }
  if (created) deps.workspaces.save({ ...created, cwd: m.cwd, nodes: m.nodes, bridges: m.bridges })
  const routineStore = m.routines.length ? deps.routines() : null
  for (const r of m.routines) routineStore?.create(r)
  const routines = { created: routineStore ? m.routines.length : 0, skipped: routineStore ? 0 : m.routines.length }
  return existing
    ? { status: 200, body: { workspaceId: existing.id, nodes: m.nodes, bridges: m.bridges, routines } }
    : { status: 201, body: { workspace: deps.workspaces.get(created!.id), routines } }
}
