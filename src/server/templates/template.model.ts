// Canvas templates ("factories", PLAN/02-fase.md F6): the shape of a saved setup and its validation.
// Pure (no bun:sqlite), so vitest and bun test both load it.
//
// Imitated:
// - Dev Container Templates (containers.dev/implementors/templates): `id` + `version` + `name` +
//   `description` metadata, and an `options` map of string options with `description`, `default`
//   and a strict `enum` / free-form `proposals`; the tool prompts for them and substitutes the chosen
//   value before anything is created.
// - Warp Workflows (docs.warp.dev .../workflows): `{{argument}}` placeholders whose names are letters,
//   digits, `-` and `_` and do not start with a digit; one value fills every occurrence.
// - tmuxinator / tmuxp: a session is a list of windows/panes, each with its own start command.
//
// SECURITY: imported files are untrusted. Parameters are DATA: they are substituted only into
// display/prompt fields (titles, notes, prompts, plan intent, worktree branch, browser URL,
// workspace cwd) and never into anything executed (`cmd`, routine precheck, plan verifyCmd, cron).
// A placeholder in an executed field is rejected at validation, so no value can ever reach a shell.
import type { PlanTaskData, WsNodeKind } from '../../shared/workspace'
import { parseRoutineInput, type RoutineInput } from '../routines/routineModel'
import { DagError, validateTasks } from '../dag/dag.model'

export const TEMPLATE_FORMAT = 'webterm-template'
export const TEMPLATE_VERSION = 1
export const TEMPLATE_MAX_NODES = 50
export const TEMPLATE_MAX_BYTES = 256 * 1024
const NAME_MAX = 120
const TEXT_MAX = 4000
const CMD_MAX = 500
const PARAM_VALUE_MAX = 1000
const MAX_PARAMS = 20
const MAX_NOTES = 20
const MAX_ROUTINES = 10
/** Kinds a template may hold; `app` is left out (an app node is placed by an agent's published MCP view, not by hand). */
export const TEMPLATE_KINDS: readonly WsNodeKind[] = ['terminal', 'agent', 'agentChat', 'files', 'editor', 'browser', 'diff', 'plan']
const KINDS = TEMPLATE_KINDS
/** Warp argument name rule. */
const PARAM_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,39})\s*\}\}/g
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/

/** One prompted parameter (devcontainer template option, string type only). */
export interface TemplateParam { id: string; description: string; default?: string; enum?: string[] }

export interface TemplateNode {
  /** Stable key inside the template; cables refer to it. Instantiation mints fresh node ids. */
  key: string
  kind: WsNodeKind
  x: number
  y: number
  width?: number
  height?: number
  title?: string
  color?: string
  agentId?: string
  /** Launch command, run as-is; never parameterized (see SECURITY above). */
  cmd?: string
  /** Browser start URL; after substitution it must parse as http(s) (URL.href percent-encodes the rest). */
  url?: string
  /** Linked notes: the node's comment thread (text only). */
  notes?: string[]
  /** Run this node in its own git worktree of the workspace repo. `branch` absent = from the title. */
  worktree?: { branch?: string }
  /** Plan node skeleton: the intent plus optional draft tasks (approved by a human later). */
  plan?: { intent: string; title?: string; tasks?: PlanTaskData[] }
}

export interface TemplateCable { from: string; to: string; kind: 'context' | 'file' }
export type TemplateRoutine = Omit<RoutineInput, 'workspaceId' | 'enabled'>

export interface WebtermTemplate {
  format: typeof TEMPLATE_FORMAT
  version: typeof TEMPLATE_VERSION
  id: string
  name: string
  description: string
  /** Workspace folder; may be a placeholder like `{{repo}}`. Absent = the target workspace's. */
  cwd?: string
  params: TemplateParam[]
  nodes: TemplateNode[]
  cables: TemplateCable[]
  routines: TemplateRoutine[]
  builtin?: boolean
}

export class TemplateError extends Error {
  constructor(readonly code: 'invalid_template' | 'invalid_params' | 'not_found' | 'builtin_readonly', message: string) {
    super(message)
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const bad = (msg: string): never => { throw new TemplateError('invalid_template', msg) }

function text(v: unknown, field: string, max = TEXT_MAX, required = false): string | undefined {
  if (v === undefined || v === null || v === '') return required ? bad(`${field} is required`) : undefined
  if (typeof v !== 'string' || v.length > max) return bad(`${field} must be a string of at most ${max} chars`)
  return v
}

function num(v: unknown, field: string, optional = false): number | undefined {
  if (v === undefined && optional) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e6) return bad(`${field} must be a finite number`)
  return v
}

/** Placeholder ids used in `s`. */
export const placeholders = (s: string): string[] => [...s.matchAll(PLACEHOLDER_RE)].map((m) => m[1])

/** An executed field: one line, no placeholder, bounded. */
function command(v: unknown, field: string): string | undefined {
  const c = text(v, field, CMD_MAX)
  if (c === undefined) return undefined
  if (CONTROL_RE.test(c)) bad(`${field} must be one line without control characters`)
  if (c.includes('{{')) bad(`${field} may not contain {{parameters}}: commands are never parameterized`)
  return c
}

function param(v: unknown, i: number): TemplateParam {
  if (!isObj(v)) return bad(`params[${i}] must be an object`)
  const id = text(v.id, `params[${i}].id`, 40, true)!
  if (!PARAM_ID_RE.test(id)) bad(`params[${i}].id must match ${PARAM_ID_RE}`)
  const p: TemplateParam = { id, description: text(v.description, `params[${i}].description`, 300) ?? '' }
  const def = text(v.default, `params[${i}].default`, PARAM_VALUE_MAX)
  if (def !== undefined) p.default = def
  if (v.enum !== undefined) {
    if (!Array.isArray(v.enum) || v.enum.length === 0 || v.enum.length > 50) bad(`params[${i}].enum must be 1..50 strings`)
    p.enum = (v.enum as unknown[]).map((e, j) => text(e, `params[${i}].enum[${j}]`, PARAM_VALUE_MAX, true)!)
  }
  return p
}

function planTasks(v: unknown, field: string): PlanTaskData[] | undefined {
  if (v === undefined || (Array.isArray(v) && v.length === 0)) return undefined
  if (Array.isArray(v) && v.some((t) => isObj(t) && isObj(t.brief) && JSON.stringify(t.brief['verifyCmd'] ?? '').includes('{{'))) {
    bad(`${field}: verifyCmd may not contain {{parameters}}`)
  }
  try {
    return validateTasks(v).map((t) => ({ key: t.key, kind: t.kind, deps: t.deps, brief: t.brief as unknown as Record<string, unknown> }))
  } catch (e) {
    if (e instanceof DagError) return bad(`${field}: ${e.message}`)
    throw e
  }
}

function node(v: unknown, i: number): TemplateNode {
  const f = `nodes[${i}]`
  if (!isObj(v)) return bad(`${f} must be an object`)
  const key = text(v.key, `${f}.key`, 40, true)!
  if (!KEY_RE.test(key)) bad(`${f}.key must match ${KEY_RE}`)
  if (!KINDS.includes(v.kind as WsNodeKind)) bad(`${f}.kind must be one of ${KINDS.join(', ')}`)
  const n: TemplateNode = { key, kind: v.kind as WsNodeKind, x: num(v.x, `${f}.x`)!, y: num(v.y, `${f}.y`)! }
  const w = num(v.width, `${f}.width`, true); if (w !== undefined) n.width = w
  const h = num(v.height, `${f}.height`, true); if (h !== undefined) n.height = h
  const title = text(v.title, `${f}.title`, NAME_MAX); if (title !== undefined) n.title = title
  const color = text(v.color, `${f}.color`, 32); if (color !== undefined) n.color = color
  const agentId = text(v.agentId, `${f}.agentId`, 80); if (agentId !== undefined) n.agentId = agentId
  const cmd = command(v.cmd, `${f}.cmd`); if (cmd !== undefined) n.cmd = cmd
  const url = text(v.url, `${f}.url`, 2000); if (url !== undefined) n.url = url
  if (n.kind === 'agentChat' && (n.cmd !== undefined || (n.agentId ?? 'claude') !== 'claude')) bad(`${f}: an agentChat node runs Claude and takes no cmd`)
  if (v.notes !== undefined) {
    if (!Array.isArray(v.notes) || v.notes.length > MAX_NOTES) bad(`${f}.notes must be at most ${MAX_NOTES} strings`)
    n.notes = (v.notes as unknown[]).map((t, j) => text(t, `${f}.notes[${j}]`, TEXT_MAX, true)!)
  }
  if (v.worktree !== undefined) {
    if (!isObj(v.worktree)) bad(`${f}.worktree must be an object`)
    const branch = text((v.worktree as Obj).branch, `${f}.worktree.branch`, 200)
    n.worktree = branch === undefined ? {} : { branch }
  }
  if (v.plan !== undefined) {
    if (n.kind !== 'plan' || !isObj(v.plan)) bad(`${f}.plan is only for a plan node and must be an object`)
    const p = v.plan as Obj
    const tasks = planTasks(p.tasks, `${f}.plan.tasks`)
    const ptitle = text(p.title, `${f}.plan.title`, NAME_MAX)
    n.plan = { intent: text(p.intent, `${f}.plan.intent`, TEXT_MAX) ?? '', ...(ptitle ? { title: ptitle } : {}), ...(tasks ? { tasks } : {}) }
  }
  return n
}

function routine(v: unknown, i: number): TemplateRoutine {
  if (isObj(v) && isObj(v.precheck)) command(v.precheck.command, `routines[${i}].precheck.command`)
  if (isObj(v) && isObj(v.trigger) && typeof v.trigger.cron === 'string' && v.trigger.cron.includes('{{')) bad(`routines[${i}].trigger may not be parameterized`)
  const parsed = parseRoutineInput(isObj(v) ? { ...v, workspaceId: null } : v)
  if (typeof parsed === 'string') return bad(`routines[${i}]: ${parsed}`)
  const { workspaceId: _w, enabled: _e, ...rest } = parsed
  return rest
}

/** Schema check of an untrusted value (an imported file, a stored row). Throws TemplateError. */
export function validateTemplate(raw: unknown): WebtermTemplate {
  if (!isObj(raw)) return bad('template must be a JSON object')
  if (JSON.stringify(raw).length > TEMPLATE_MAX_BYTES) bad(`template is larger than ${TEMPLATE_MAX_BYTES} bytes`)
  if (raw.format !== TEMPLATE_FORMAT) bad(`format must be "${TEMPLATE_FORMAT}"`)
  if (raw.version !== TEMPLATE_VERSION) bad(`version ${String(raw.version)} is not supported (expected ${TEMPLATE_VERSION})`)
  const id = text(raw.id, 'id', 80, true)!
  if (!KEY_RE.test(id)) bad(`id must match ${KEY_RE}`)
  const name = text(raw.name, 'name', NAME_MAX, true)!.trim()
  const list = (k: string, max: number): unknown[] => {
    const v = raw[k] ?? []
    if (!Array.isArray(v) || v.length > max) bad(`${k} must be an array of at most ${max} items`)
    return v as unknown[]
  }
  const params = list('params', MAX_PARAMS).map(param)
  if (new Set(params.map((p) => p.id)).size !== params.length) bad('param ids must be unique')
  const nodes = list('nodes', TEMPLATE_MAX_NODES).map(node)
  if (nodes.length === 0) bad('a template needs at least one node')
  const keys = new Set(nodes.map((n) => n.key))
  if (keys.size !== nodes.length) bad('node keys must be unique')
  const cables = list('cables', TEMPLATE_MAX_NODES * 4).map((c, i): TemplateCable => {
    if (!isObj(c) || typeof c.from !== 'string' || typeof c.to !== 'string' || !keys.has(c.from) || !keys.has(c.to) || c.from === c.to) {
      return bad(`cables[${i}] must join two different node keys of this template`)
    }
    return { from: c.from, to: c.to, kind: c.kind === 'file' ? 'file' : 'context' }
  })
  const routines = list('routines', MAX_ROUTINES).map(routine)
  const cwd = text(raw.cwd, 'cwd', 1000)
  const t: WebtermTemplate = {
    format: TEMPLATE_FORMAT, version: TEMPLATE_VERSION, id, name, description: text(raw.description, 'description', 1000) ?? '',
    ...(cwd ? { cwd } : {}), params, nodes, cables, routines,
  }
  const declared = new Set(params.map((p) => p.id))
  const unknown = placeholders(JSON.stringify(t)).filter((p) => !declared.has(p))
  if (unknown.length) bad(`undeclared parameter(s): ${[...new Set(unknown)].join(', ')}`)
  return t
}

/** Every declared parameter resolved: given value, else default; enum enforced. Throws invalid_params. */
export function resolveParams(t: WebtermTemplate, given: unknown): Record<string, string> {
  const g = isObj(given) ? given : {}
  const out: Record<string, string> = {}
  for (const p of t.params) {
    const v = g[p.id] === undefined || g[p.id] === '' ? p.default : g[p.id]
    if (typeof v !== 'string' || v === '') throw new TemplateError('invalid_params', `${p.id} is required`)
    if (v.length > PARAM_VALUE_MAX) throw new TemplateError('invalid_params', `${p.id} is longer than ${PARAM_VALUE_MAX} chars`)
    if (p.enum && !p.enum.includes(v)) throw new TemplateError('invalid_params', `${p.id} must be one of ${p.enum.join(', ')}`)
    out[p.id] = v
  }
  return out
}

/**
 * Literal, single-pass substitution: a value is inserted as-is (a value containing `{{x}}` is not
 * expanded again) and nothing is evaluated.
 */
export function substitute(s: string, values: Readonly<Record<string, string>>): string {
  return s.replace(PLACEHOLDER_RE, (whole, id: string) => (Object.hasOwn(values, id) ? values[id] : whole))
}

/** True when `s` has a control character (a cwd or branch must not). */
export const hasControl = (s: string): boolean => CONTROL_RE.test(s)
