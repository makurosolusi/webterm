// canvas.open (R1) / canvas.close (R2): Central's bulk canvas control ("open 3 terminals", "close the idle
// browsers"). Writes go through the shared CanvasPush, so open windows add/drop the nodes live; closed
// nodes stay reopenable from webterm. cwd always comes from the project's workspace, never from the model.
// Named `canvas.*`, not `node.*`: the control API's `node.close`/`node.spawn` (capability/control.capabilities.ts)
// act on ONE session (node scope); these edit a project's board in bulk, a different capability.
import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { agentConfig } from '../../../../shared/workspace'
import { parseBrowserUrl } from '../../../../shared/browser.url'
import { withNodeNames } from '../../../../shared/nodeNames'
import type { CanvasNode, CanvasPush } from '../../../canvas/canvasPush'
import { claudeLaunchLine, resolveClaudeLaunch } from '../../../claudeLauncher/claudeLauncher'
import { allRows } from '../../../ledger/ledgerCore'
import { AGENT_TERMINAL_STATES } from '../../contracts/agent.types'
import { lookupWorkspace, projectWorkspace } from '../../workspaceLookup'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { obj, S } from '../../../capability/capability.schema'
import { clip, isSafeId, MAX_ID, READ_TOOLS_FLAG } from './read.shared'

/** The two CanvasPush writes these tools use (tests pass a fake). */
export type NodeCanvas = Pick<CanvasPush, 'add' | 'remove'>
export interface CanvasActDeps {
  /** Resolved per call so the runtime (db + broadcaster) is only loaded when a tool runs. */
  canvas(): NodeCanvas | Promise<NodeCanvas>
  /** Live "Browser on canvas" Settings switch, read per call so turning it off refuses browser opens at once. */
  browserOn(): boolean
}

const MAX_CLOSE = 50
const MAX_OPEN = 5
const MAX_TITLE = 80
const MAX_REASON = 200
const KINDS = ['terminal', 'claude', 'browser'] as const
/** Same size as the client's URL-open path (`BROWSER_OPEN_SIZE`, client/browser.open.place.ts) and browser.agentOpen.ts. */
const BROWSER_SIZE = { width: 640, height: 400 }

const onlyKeys = (input: ToolInput, allowed: readonly string[]): boolean => Object.keys(input).every((k) => allowed.includes(k))
const noControl = (s: string): boolean => !/[\x00-\x08\x0b-\x1f\x7f]/.test(s)
const text = (v: unknown, max: number): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= max && noControl(v)
const fail = (code: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, code, ...(data ? { data } : {}) })
/** A node name as `withNodeNames` mints it ("Mango", tier "Mango 2"); custom names in other shapes close by id. */
const NAME_REF = /^[A-Za-z][A-Za-z0-9]*( [0-9]+)?$/
const MAX_NAME_REF = 40
const isNodeRef = (v: unknown): boolean => isSafeId(v) || (typeof v === 'string' && v.length <= MAX_NAME_REF && NAME_REF.test(v))

function closeShape(input: ToolInput): boolean {
  const ids = input.nodeIds
  return onlyKeys(input, ['projectId', 'nodeIds', 'reason']) && Array.isArray(ids) && ids.length >= 1 && ids.length <= MAX_CLOSE
    && ids.every(isNodeRef) && text(input.reason, MAX_REASON)
}

function openShape(input: ToolInput): boolean {
  const { kind, count, title, url } = input
  if (!onlyKeys(input, ['projectId', 'kind', 'count', 'title', 'url'])) return false
  if (!KINDS.includes(kind as (typeof KINDS)[number])) return false
  if (count !== undefined && (kind === 'browser' || !Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > MAX_OPEN)) return false
  if (title !== undefined && !text(title, MAX_TITLE)) return false
  return url === undefined || (kind === 'browser' && parseBrowserUrl(url).ok)
}

/** Node ids (of `ids`) that are live Central-managed agent PTYs: those close through `agent.close`. */
function agentNodeIds(db: Database, projectId: string, ids: string[]): string[] {
  const marks = ids.map(() => '?').join(',')
  const ended = AGENT_TERMINAL_STATES.map(() => '?').join(',')
  const rows = allRows(db,
    `SELECT id, node_id FROM central_agents WHERE project_id = ? AND runner = 'pty' AND state NOT IN (${ended})
       AND (node_id IN (${marks}) OR ('c-' || id) IN (${marks}))`,
    projectId, ...AGENT_TERMINAL_STATES, ...ids, ...ids)
  const hit = new Set(rows.flatMap((r) => [String(r['node_id'] ?? ''), `c-${String(r['id'])}`]))
  return ids.filter((id) => hit.has(id))
}

/** The node the client's add buttons build (App.board.ts terminal/agent, useBrowserOpen.ts); x/y are placed by CanvasPush. */
function buildNode(kind: (typeof KINDS)[number], cwd: string | undefined, title: string | undefined, url: string | undefined): CanvasNode {
  const base = { id: randomUUID(), x: 0, y: 0, ...(title ? { title } : {}) }
  if (kind === 'browser') return { ...base, kind: 'browser', ...BROWSER_SIZE, ...(url ? { url } : {}) }
  const where = cwd ? { cwd } : {}
  if (kind === 'terminal') return { ...base, kind: 'terminal', ...where }
  // Builtin claude records the default launch profile, as template.instantiate.ts does; no sessionId:
  // AgentNode mints it on mount (App.board.ts), a pre-minted one would make the first launch `--resume`.
  const launch = resolveClaudeLaunch()
  const color = agentConfig('claude')?.color
  return { ...base, kind: 'agent', agentId: 'claude', cmd: claudeLaunchLine(launch), claudeProfileId: launch.profile.id, ...where, ...(color ? { color } : {}) }
}

/** Builds canvas.open and canvas.close bound to `deps.canvas`. */
export function createCanvasActDefs(deps: CanvasActDeps): ToolDef[] {
  const close: ToolDef = {
    name: 'canvas.close',
    summary: 'Close canvas nodes (terminals, browsers, files...) of a project workspace by ids or names; asks the user.',
    tier: 'R2',
    flag: READ_TOOLS_FLAG,
    usage: '{"projectId":"<id>","nodeIds":["<node id or name from node.list, e.g. Mango>", ... 1-50],"reason":"<why, <=200 chars>"}. '
      + 'Names match case-insensitively. All-or-nothing: one unknown id or name refuses the whole call. Ends their sessions/pages; the user can Reopen closed nodes '
      + 'from webterm. Workers you spawned close with agent.close instead.',
    input: obj({ nodeIds: S.arr(S.str(MAX_ID), MAX_CLOSE), reason: S.str(MAX_REASON) }, ['nodeIds', 'reason']),
    output: S.keys('closed', 'count', 'ids'),
    auditKeys: ['count', 'ids'],
    validate: (input) => (closeShape(input) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const found = projectWorkspace(ctx.db, projectId)
      if (!found.ok) return fail(found.code)
      const named = withNodeNames((found.nodes as Array<{ id?: unknown; name?: unknown }>)
        .map((n) => ({ id: String(n.id), name: typeof n.name === 'string' ? n.name : undefined })))
      const nameOf = new Map(named.map((n) => [n.id, n.name]))
      const idOfName = new Map(named.map((n) => [n.name.toLowerCase(), n.id]))
      // An exact id wins over a name; whatever matches neither refuses the whole call.
      const refs = input.nodeIds as string[]
      const resolved = refs.map((r) => (nameOf.has(r) ? r : idOfName.get(r.toLowerCase())))
      const unknown = refs.filter((_, i) => resolved[i] === undefined)
      if (unknown.length) return fail('node_not_found', { unknown })
      const ids = [...new Set(resolved as string[])]
      const agents = agentNodeIds(ctx.db, String(projectId), ids)
      if (agents.length) return fail('use_agent_close', { nodeIds: agents, hint: 'These are workers you spawned: close them with agent.close.' })
      const res = (await deps.canvas()).remove({ workspaceId: found.workspaceId, nodeIds: ids })
      if (!res.ok) return fail(res.code)
      const closed = res.removed.map((n) => ({ id: n.id, name: nameOf.get(n.id) ?? null, kind: n.kind, title: n.title ? clip(n.title, MAX_TITLE) : null }))
      return { ok: true, data: { closed, count: closed.length, ids: closed.map((n) => n.id) } }
    },
  }

  const open: ToolDef = {
    name: 'canvas.open',
    summary: 'Open new terminal, Claude or browser nodes on a project canvas, in the project directory.',
    tier: 'R1',
    flag: READ_TOOLS_FLAG,
    usage: '{"projectId":"<id>","kind":"terminal"|"claude"|"browser","count":<1-5, default 1; terminal/claude only>,'
      + '"title":"<optional, <=80 chars>","url":"<optional http(s) URL; browser only>"}. Nodes open in free space in the '
      + 'project directory. A browser url passes the same navigation guard as the user; a blocked one leaves the page blank.',
    input: obj({ kind: S.oneOf(...KINDS), count: S.int(1, MAX_OPEN), title: S.str(MAX_TITLE), url: S.str() }, ['kind']),
    output: S.keys('opened', 'count', 'kind', 'ids'),
    auditKeys: ['count', 'kind', 'ids'],
    validate: (input) => (openShape(input) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const kind = input.kind as (typeof KINDS)[number]
      if (kind === 'browser' && !deps.browserOn()) {
        return fail('browser_disabled', { hint: 'The browser feature is off in Settings. Only the user can turn it on; do not retry.' })
      }
      const found = projectWorkspace(ctx.db, projectId)
      if (!found.ok) return fail(found.code)
      const parsed = input.url === undefined ? null : parseBrowserUrl(input.url)
      const url = parsed?.ok ? parsed.url : undefined
      const cwd = lookupWorkspace(found.workspaceId)?.cwd || undefined
      const title = typeof input.title === 'string' ? input.title.trim() : undefined
      const nodes = Array.from({ length: (input.count as number | undefined) ?? 1 }, () => buildNode(kind, cwd, title, url))
      const res = (await deps.canvas()).add({ workspaceId: found.workspaceId, nodes })
      if (!res.ok) return fail(res.code)
      const opened = res.nodes.map((n) => ({ id: n.id, name: n.name ?? null, kind: n.kind }))
      return { ok: true, data: { opened, count: opened.length, kind, ids: opened.map((n) => n.id) } }
    },
  }

  return [open, close]
}
