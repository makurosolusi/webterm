// canvas.open (R1) / canvas.close (R2): Central's bulk canvas control ("open 3 terminals", "close the idle
// browsers"). Writes go through the shared CanvasPush, so open windows add/drop the nodes live; closed
// nodes stay reopenable from webterm. cwd always comes from the project's workspace, never from the model.
// Named `canvas.*`, not `node.*`: the control API's `node.close`/`node.spawn` (capability/control.capabilities.ts)
// act on ONE session (node scope); these edit a project's board in bulk, a different capability.
import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Database } from 'bun:sqlite'
import { agentConfig } from '../../../../shared/workspace'
import { parseBrowserUrl } from '../../../../shared/browser.url'
import { isNodeName, withNodeNames } from '../../../../shared/nodeNames'
import type { CanvasNode, CanvasPush } from '../../../canvas/canvasPush'
import { claudeLaunchLine, resolveClaudeLaunch } from '../../../claudeLauncher/claudeLauncher'
import { allRows } from '../../../ledger/ledgerCore'
import { AGENT_TERMINAL_STATES } from '../../contracts/agent.types'
import { lookupWorkspace, projectWorkspace } from '../../workspaceLookup'
import { isInsideRoot } from '../../../orchestrator/safePath'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { containsForbidden } from '../toolValidate'
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
const MAX_PATH = 1024
const KINDS = ['terminal', 'claude', 'browser', 'files', 'editor', 'diff'] as const
type Kind = (typeof KINDS)[number]
/** Kinds that open in the project directory, so they need the workspace cwd. */
const DIR_KINDS: readonly Kind[] = ['files', 'editor', 'diff']
/** Same size as the client's URL-open path (`BROWSER_OPEN_SIZE`, client/browser.open.place.ts) and browser.agentOpen.ts. */
const BROWSER_SIZE = { width: 640, height: 400 }
/** The client's `EDITOR_SIZE` (client/fileOpen.ts). */
const EDITOR_SIZE = { width: 660, height: 460 }

const onlyKeys = (input: ToolInput, allowed: readonly string[]): boolean => Object.keys(input).every((k) => allowed.includes(k))
const noControl = (s: string): boolean => !/[\x00-\x08\x0b-\x1f\x7f]/.test(s)
const text = (v: unknown, max: number): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= max && noControl(v)
const fail = (code: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, code, ...(data ? { data } : {}) })
/** A node id, or a node name as `withNodeNames` mints it ("Mango", tier "Mango 2") in any case. */
const isNodeRef = (v: unknown): boolean => isSafeId(v) || isNodeName(v, true)

function closeShape(input: ToolInput): boolean {
  const ids = input.nodeIds
  return onlyKeys(input, ['projectId', 'nodeIds', 'reason']) && Array.isArray(ids) && ids.length >= 1 && ids.length <= MAX_CLOSE
    && ids.every(isNodeRef) && text(input.reason, MAX_REASON)
}

function openShape(input: ToolInput): boolean {
  const { kind, count, title, url, path } = input
  if (!onlyKeys(input, ['projectId', 'kind', 'count', 'title', 'url', 'path'])) return false
  if (!KINDS.includes(kind as Kind)) return false
  const many = kind === 'terminal' || kind === 'claude'
  if (count !== undefined && (!many || !Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > MAX_OPEN)) return false
  if (title !== undefined && !text(title, MAX_TITLE)) return false
  if (kind === 'editor' ? !text(path, MAX_PATH) : path !== undefined && (kind !== 'files' || !text(path, MAX_PATH))) return false
  return url === undefined || (kind === 'browser' && parseBrowserUrl(url).ok)
}

/**
 * `path` (relative = against `cwd`) as the absolute path the files node would hand the editor
 * (cwd + relative, lexical), after checking its real path (symlinks followed) stays inside the
 * real `cwd` and is a directory (`wantDir`) or a file. The lexical check runs first, so an escaping
 * path is refused without probing whether it exists.
 */
export function resolveProjectPath(cwd: string, path: string, wantDir: boolean): { ok: true; path: string } | { ok: false; code: string } {
  const abs = resolve(cwd, path)
  if (!isInsideRoot(cwd, abs)) return { ok: false, code: 'path_outside_project' }
  let real: string
  try { real = realpathSync(abs) } catch { return { ok: false, code: 'path_not_found' } } // ENOENT/ENOTDIR/ELOOP: nothing to open
  let root: string
  try { root = realpathSync(cwd) } catch { return { ok: false, code: 'no_project_dir' } }
  if (!isInsideRoot(root, real)) return { ok: false, code: 'path_outside_project' }
  if (statSync(real).isDirectory() !== wantDir) return { ok: false, code: 'path_wrong_type' }
  return { ok: true, path: abs }
}

/** Live Central-managed agent PTYs shown as one of `ids` (by node_id or `c-<agentId>`), node id -> agent id.
 *  Those nodes are driven through the agent.* tools, never canvas.close / canvas.type. */
export function liveAgentNodes(db: Database, projectId: string, ids: string[]): Map<string, string> {
  const marks = ids.map(() => '?').join(',')
  const ended = AGENT_TERMINAL_STATES.map(() => '?').join(',')
  const rows = allRows(db,
    `SELECT id, node_id FROM central_agents WHERE project_id = ? AND runner = 'pty' AND state NOT IN (${ended})
       AND (node_id IN (${marks}) OR ('c-' || id) IN (${marks}))`,
    projectId, ...AGENT_TERMINAL_STATES, ...ids, ...ids)
  const byNode = new Map<string, string>()
  for (const r of rows) {
    const agentId = String(r['id'])
    for (const node of [String(r['node_id'] ?? ''), `c-${agentId}`]) if (ids.includes(node) && !byNode.has(node)) byNode.set(node, agentId)
  }
  return byNode
}

/** The node the client builds (App.board.ts terminal/agent/files/diff, useBrowserOpen.ts, Omnibox.open.ts
 *  editor); x/y are placed by CanvasPush. `path` is the resolved dir (files) or file (editor). */
function buildNode(kind: Kind, cwd: string | undefined, title: string | undefined, url: string | undefined, path: string | undefined): CanvasNode {
  const base = { id: randomUUID(), x: 0, y: 0, ...(title ? { title } : {}) }
  if (kind === 'browser') return { ...base, kind: 'browser', ...BROWSER_SIZE, ...(url ? { url } : {}) }
  if (kind === 'files') return { ...base, kind: 'files', dirPath: path ?? cwd }
  if (kind === 'editor') return { ...base, kind: 'editor', title: title ?? basename(path!), filePath: path, ...EDITOR_SIZE }
  if (kind === 'diff') return { ...base, kind: 'diff', cwd, title: title ?? 'Changes' }
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
      const live = liveAgentNodes(ctx.db, String(projectId), ids)
      const agents = ids.filter((id) => live.has(id))
      if (agents.length) return fail('use_agent_close', { nodeIds: agents, hint: 'These are workers you spawned: close them with agent.close.' })
      const res = (await deps.canvas()).remove({ workspaceId: found.workspaceId, nodeIds: ids })
      if (!res.ok) return fail(res.code)
      const closed = res.removed.map((n) => ({ id: n.id, name: nameOf.get(n.id) ?? null, kind: n.kind, title: n.title ? clip(n.title, MAX_TITLE) : null }))
      return { ok: true, data: { closed, count: closed.length, ids: closed.map((n) => n.id) } }
    },
  }

  const open: ToolDef = {
    name: 'canvas.open',
    summary: 'Open terminal, Claude, browser, files, file editor or git diff nodes on a project canvas.',
    tier: 'R1',
    flag: READ_TOOLS_FLAG,
    usage: '{"projectId":"<id>","kind":"terminal"|"claude"|"browser"|"files"|"editor"|"diff","count":<1-5, default 1; terminal/claude only>,'
      + '"title":"<optional, <=80 chars>","url":"<optional http(s) URL; browser only>","path":"<files: optional folder, default the '
      + 'project directory; editor: required file>"}. path is relative to the project directory (absolute also works) and must stay inside it. '
      + 'An editor for a file already open is reused, not doubled. diff shows the project\'s git changes. Nodes open in free space in the '
      + 'project directory. A browser url passes the same navigation guard as the user; a blocked one leaves the page blank.',
    input: obj({ kind: S.oneOf(...KINDS), count: S.int(1, MAX_OPEN), title: S.str(MAX_TITLE), url: S.str(), path: S.str(MAX_PATH) }, ['kind']),
    output: S.keys('opened', 'count', 'kind', 'ids'),
    auditKeys: ['count', 'kind', 'ids'],
    // `path` is a forbidden key for other tools but is this tool's own field, confined to the project
    // directory by resolveProjectPath; every other key (deep) stays forbidden.
    forbidden: ({ path: _path, ...rest }) => containsForbidden(rest),
    validate: (input) => (openShape(input) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const kind = input.kind as Kind
      if (kind === 'browser' && !deps.browserOn()) {
        return fail('browser_disabled', { hint: 'The browser feature is off in Settings. Only the user can turn it on; do not retry.' })
      }
      const found = projectWorkspace(ctx.db, projectId)
      if (!found.ok) return fail(found.code)
      const parsed = input.url === undefined ? null : parseBrowserUrl(input.url)
      const url = parsed?.ok ? parsed.url : undefined
      const cwd = lookupWorkspace(found.workspaceId)?.cwd || undefined
      const title = typeof input.title === 'string' ? input.title.trim() : undefined
      if (DIR_KINDS.includes(kind) && !cwd) return fail('no_project_dir', { hint: 'This project has no directory; set one in webterm first.' })
      let path: string | undefined
      if (typeof input.path === 'string') {
        const hit = resolveProjectPath(cwd!, input.path, kind === 'files')
        if (!hit.ok) return fail(hit.code)
        path = hit.path
      }
      // One file = one editor (client `openEditorFor`, fileOpen.ts): an open one is reported, not doubled.
      const same = kind === 'editor' ? (found.nodes as CanvasNode[]).find((n) => n.kind === 'editor' && n.filePath === path) : undefined
      if (same) return { ok: true, data: { opened: [{ id: same.id, name: same.name ?? null, kind: 'editor' }], count: 1, kind, ids: [same.id], alreadyOpen: true } }
      const nodes = Array.from({ length: (input.count as number | undefined) ?? 1 }, () => buildNode(kind, cwd, title, url, path))
      const res = (await deps.canvas()).add({ workspaceId: found.workspaceId, nodes })
      if (!res.ok) return fail(res.code)
      const opened = res.nodes.map((n) => ({ id: n.id, name: n.name ?? null, kind: n.kind }))
      return { ok: true, data: { opened, count: opened.length, kind, ids: opened.map((n) => n.id) } }
    },
  }

  return [open, close]
}
