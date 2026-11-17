// "Save as template": a live workspace -> a template. Keeps layout, kinds, cables, launch commands,
// agent kinds, notes, the plan skeleton and the workspace's routines. Drops everything that is
// per-run, per-machine or secret: session ids, transcripts (never in the node blob), node tokens,
// absolute paths, pane ids, diff review notes, dag/plan job ids, browser URL query strings, and the
// browser agent-control grant. Free text goes through the server's one secret scrubber.
import type { Workspace, WsNode } from '../../shared/workspace'
import { redactSecrets } from '../redactSecrets'
import type { Routine } from '../routines/routineModel'
import { validateTasks } from '../dag/dag.model'
import { TEMPLATE_FORMAT, TEMPLATE_VERSION, validateTemplate, type TemplateNode, type WebtermTemplate } from './template.model'

/** A half-written planner draft is dropped (the intent stays) rather than failing the whole save. */
function tasksValid(tasks: unknown): boolean {
  try { validateTasks(tasks); return true } catch { return false }
}

/** `--resume <id>` / `--session-id <id>` belong to one conversation, not to a template. */
const SESSION_FLAG_RE = /\s+--(?:resume|session-id)(?:=|\s+)\S+/g

/** Origin + path only: a query or fragment is where tokens live (`?token=`, OAuth `#access_token`). */
function safeUrl(u: string): string | undefined {
  try {
    const url = new URL(u)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return redactSecrets(`${url.origin}${url.pathname}`)
  } catch {
    return undefined
  }
}

function captureNode(n: WsNode, i: number, wsCwd: string | undefined, worktreeRoot: string | undefined): TemplateNode {
  const t: TemplateNode = { key: `n${i + 1}`, kind: n.kind, x: Math.round(n.x), y: Math.round(n.y) }
  if (n.width) t.width = Math.round(n.width)
  if (n.height) t.height = Math.round(n.height)
  if (n.title) t.title = redactSecrets(n.title).slice(0, 120)
  if (n.color) t.color = n.color
  if (n.agentId) t.agentId = n.agentId
  if (n.cmd) t.cmd = redactSecrets(n.cmd.replace(SESSION_FLAG_RE, '')).replace(/[\r\n]+/g, ' ').trim().slice(0, 500) || undefined
  if (!t.cmd) delete t.cmd
  if (n.url) { const u = safeUrl(n.url); if (u) t.url = u }
  const notes = (n.comments ?? []).map((c) => redactSecrets(c.text).slice(0, 4000)).filter((s) => s.trim() !== '').slice(0, 20)
  if (notes.length) t.notes = notes
  if (worktreeRoot && n.cwd && n.cwd !== wsCwd && n.cwd.startsWith(`${worktreeRoot}/`)) t.worktree = {}
  if (n.kind === 'plan' && n.plan) {
    t.plan = { intent: redactSecrets(n.plan.intent) }
    if (n.plan.draft && tasksValid(n.plan.draft.tasks)) t.plan = { ...t.plan, title: n.plan.draft.title.slice(0, 120), tasks: n.plan.draft.tasks }
  }
  return t
}

export interface CaptureInput {
  ws: Workspace
  id: string
  name: string
  description?: string
  /** This workspace's routines (empty when the ledger is off or the user left them out). */
  routines: readonly Routine[]
  /** webterm-managed worktree root: a node whose cwd is under it becomes a worktree node. */
  worktreeRoot?: string
}

/** Workspace -> validated template (validation also proves the capture is importable). */
export function captureTemplate(input: CaptureInput): WebtermTemplate {
  const { ws } = input
  // A skill node references a library skill by name (docs/decisions/skill-canvas-nodes.md): not portable, so
  // it and its cable stay out of a template (the cable drops because its source has no key).
  const kept = ws.nodes.filter((n) => n.kind !== 'skill').slice(0, 50)
  const nodes = kept.map((n, i) => captureNode(n, i, ws.cwd, input.worktreeRoot))
  const keyOf = new Map(kept.map((n, i) => [n.id, nodes[i].key]))
  const cables = ws.bridges.flatMap((b) => {
    const from = keyOf.get(b.source), to = keyOf.get(b.target)
    return from && to && from !== to ? [{ from, to, kind: b.kind }] : []
  })
  const routines = input.routines.filter((r) => r.workspaceId === ws.id).slice(0, 10).map((r) => ({
    name: r.name, trigger: r.trigger, precheck: r.precheck, budget: r.budget,
    action: r.action.type === 'spawn' ? { ...r.action, prompt: redactSecrets(r.action.prompt) }
      : r.action.type === 'outbox' ? { ...r.action, body: redactSecrets(r.action.body) } : r.action,
  }))
  // Captured text is the user's own and holds no {{…}}: escape a literal one so validation does not
  // read it as an undeclared parameter (it renders back as `{ {` — visible, never substituted).
  const raw = JSON.parse(JSON.stringify({
    format: TEMPLATE_FORMAT, version: TEMPLATE_VERSION, id: input.id, name: input.name,
    description: input.description ?? '', params: [], nodes, cables, routines,
  }).replace(/\{\{/g, '{ {'))
  // The folder is per-machine: it becomes a prompted `repo` parameter (filled from the target
  // workspace's folder when instantiated into an existing one), never a stored absolute path.
  if (ws.cwd) Object.assign(raw, { cwd: '{{repo}}', params: [{ id: 'repo', description: 'Repository folder (absolute path).' }] })
  return validateTemplate(raw)
}
