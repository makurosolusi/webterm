// Template + parameter values -> concrete nodes, cables and routines. Values are substituted
// literally into data fields only (template.model.ts SECURITY); worktrees are made through the git
// argv helper (no shell), and routines come back PAUSED so a human reviews them before they run.
import { isAbsolute, resolve } from 'node:path'
import type { BridgeLink, WsNode } from '../../shared/workspace'
import { validPlanData } from '../../shared/workspace'
import type { RoutineAction, RoutineInput } from '../routines/routineModel'
import { claudeLaunchLine, resolveClaudeLaunch } from '../claudeLauncher/claudeLauncher'
import { isBuiltinClaudeCmd } from '../../shared/claudeLaunch/claudeLaunch.builtin'
import { hasControl, resolveParams, substitute, TemplateError, validateTemplate, type TemplateNode, type WebtermTemplate } from './template.model'

export interface InstantiateDeps {
  /** Creates a git worktree of `repo` (production: createWorkspaceWorktree, runSetup off). */
  makeWorktree: (input: { repo: string; title: string; branch?: string }) => Promise<{ path: string; branch: string }>
  newId: () => string
  now: () => number
}

export interface InstantiateTarget {
  workspaceId: string
  /** The target workspace's folder; a template `cwd` overrides it. */
  workspaceCwd?: string
  /** Shift added to every node position (place next to what is already on an existing canvas). */
  offset?: { x: number; y: number }
}

export interface Materialized {
  cwd?: string
  nodes: WsNode[]
  bridges: BridgeLink[]
  /** Workspace-bound, `enabled: false`. */
  routines: RoutineInput[]
}

const fail = (msg: string): never => { throw new TemplateError('invalid_params', msg) }

function httpUrl(s: string): string | undefined {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined
  } catch {
    return undefined
  }
}

function action(a: RoutineAction, sub: (s: string) => string): RoutineAction {
  if (a.type === 'spawn') return { type: 'spawn', prompt: sub(a.prompt) }
  if (a.type === 'outbox') return { ...a, body: sub(a.body) }
  return a
}

/** Throws TemplateError (bad params/cwd/url) or whatever `makeWorktree` throws. */
export async function instantiateTemplate(raw: WebtermTemplate, given: unknown, target: InstantiateTarget, deps: InstantiateDeps): Promise<Materialized> {
  const t = validateTemplate(raw) // stored rows are re-checked too: the DB file is not a trust anchor
  // A cwd that is just `{{x}}` defaults `x` to the target workspace's folder.
  const cwdParam = t.cwd?.match(/^\{\{\s*([A-Za-z0-9_-]+)\s*\}\}$/)?.[1]
  const g = given && typeof given === 'object' && !Array.isArray(given) ? { ...(given as Record<string, unknown>) } : {}
  if (cwdParam && (g[cwdParam] === undefined || g[cwdParam] === '') && target.workspaceCwd) g[cwdParam] = target.workspaceCwd
  const values = resolveParams(t, g)
  const sub = (s: string): string => substitute(s, values)
  const cwdRaw = t.cwd ? sub(t.cwd) : target.workspaceCwd
  let cwd: string | undefined
  if (cwdRaw !== undefined && cwdRaw !== '') {
    if (hasControl(cwdRaw) || !isAbsolute(cwdRaw)) fail('the workspace folder must be an absolute path on one line')
    cwd = resolve(cwdRaw)
  }
  if (t.nodes.some((n) => n.worktree) && !cwd) fail('worktree nodes need a repository folder')
  const off = target.offset ?? { x: 0, y: 0 }
  const ids = new Map(t.nodes.map((n) => [n.key, deps.newId()]))

  const nodes: WsNode[] = []
  for (const n of t.nodes) nodes.push(await node(n, ids.get(n.key)!, cwd, off, sub, target.workspaceId, deps))
  const bridges: BridgeLink[] = t.cables.map((c) => ({ id: deps.newId(), source: ids.get(c.from)!, target: ids.get(c.to)!, kind: c.kind }))
  const routines: RoutineInput[] = t.routines.map((r) => ({ ...r, name: sub(r.name).slice(0, 120), action: action(r.action, sub), workspaceId: target.workspaceId, enabled: false }))
  return { ...(cwd ? { cwd } : {}), nodes, bridges, routines }
}

async function node(n: TemplateNode, id: string, cwd: string | undefined, off: { x: number; y: number }, sub: (s: string) => string, workspaceId: string, deps: InstantiateDeps): Promise<WsNode> {
  const w: WsNode = { id, kind: n.kind, x: n.x + off.x, y: n.y + off.y }
  if (n.width) w.width = n.width
  if (n.height) w.height = n.height
  if (n.title) w.title = sub(n.title).slice(0, 120)
  if (n.color) w.color = n.color
  if (n.agentId) w.agentId = n.agentId
  if (n.cmd) w.cmd = n.cmd // never substituted: validation forbids placeholders here
  // Builtin claude with no command (or the stock one) records the default launch profile; the server
  // builds its command from that profile on every launch. A custom command is kept as written.
  if (n.kind === 'agent' && n.agentId === 'claude' && (!n.cmd || isBuiltinClaudeCmd(n.cmd))) {
    const launch = resolveClaudeLaunch()
    w.claudeProfileId = launch.profile.id
    w.cmd = claudeLaunchLine(launch)
  }
  // Agent Chat is always Claude and records the profile like a builtin claude agent; it has no command line.
  if (n.kind === 'agentChat') { w.agentId = 'claude'; w.claudeProfileId = resolveClaudeLaunch().profile.id }
  if (cwd && (n.kind === 'terminal' || n.kind === 'agent' || n.kind === 'agentChat' || n.kind === 'diff')) w.cwd = cwd
  if (cwd && n.kind === 'files') w.dirPath = cwd
  if (n.url) {
    const url = httpUrl(sub(n.url))
    if (!url) fail(`${n.title ?? n.key}: the browser URL must be http(s)`)
    w.url = url
  }
  if (n.notes?.length) w.comments = n.notes.map((text) => ({ id: deps.newId(), text: sub(text), ts: deps.now() }))
  if (n.worktree) {
    const branch = n.worktree.branch === undefined ? undefined : sub(n.worktree.branch)
    if (branch !== undefined && hasControl(branch)) fail('a worktree branch must be one line')
    const made = await deps.makeWorktree({ repo: cwd!, title: w.title ?? n.key, ...(branch ? { branch } : {}) })
    w.cwd = made.path
  }
  if (n.plan) {
    const plan = validPlanData({
      intent: sub(n.plan.intent), workspaceId, ...(cwd ? { repo: cwd } : {}),
      ...(n.plan.tasks ? { draft: { title: sub(n.plan.title ?? n.plan.intent).slice(0, 120), tasks: n.plan.tasks } } : {}),
    })
    if (plan) w.plan = plan
  }
  return w
}
