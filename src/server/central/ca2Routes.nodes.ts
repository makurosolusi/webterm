// `GET /api/central/nodes`: Agent Chat nodes and Claude terminals on every board that Central did not start
// ("On the board" on the Agents tab). Works with agents off: these are board nodes, not workers.
import { withNodeNames } from '../../shared/nodeNames'
import { sessionIdsOf } from '../../shared/paneSessions'
import type { Pane } from '../../shared/workspace'
import type { ChatPort } from '../agentChat/agentChat.port'
import type { RouteResult } from '../apiShared.types'
import { allRows } from '../ledger/ledgerCore'
import { redactSecrets } from '../redactSecrets'
import type { Ca2Handle } from './ca2Boot'
import { FEATURE_OFF, pageOf } from './ca2Routes.read'
import type { NodeSessionView } from './tools/defs/read.node.inspect'
import { clip } from './tools/defs/read.shared'
import { listWorkspaces } from './workspaceLookup'

const MAX_TITLE = 80
interface StoredNode { id?: unknown; name?: unknown; kind?: unknown; title?: unknown; agentId?: unknown; panes?: Pane }

/** Where live status comes from; the same two sources `node.inspect` reads. */
export interface BoardDeps {
  sessions(): NodeSessionView | Promise<NodeSessionView>
  chats(): ChatPort | Promise<ChatPort>
}

// Loaded on first call: `sessions` boots the PTY supervisor and the chat runtime opens webterm.db.
export const LIVE_BOARD: BoardDeps = {
  sessions: async () => (await import('../sessions')).sessions,
  chats: async () => (await import('../agentChat/agentChat.runtime')).agentChatPort(),
}

const isClaudeNode = (n: StoredNode): boolean => n.kind === 'agentChat' || (n.kind === 'agent' && n.agentId === 'claude')
const text = (v: unknown): string => clip(redactSecrets(String(v ?? '')), MAX_TITLE)

/** Node ids (of `ids`) that belong to a Central worker in any state, by `node_id` or the `c-<agentId>` convention. */
function centralNodes(h: Ca2Handle, ids: string[]): Set<string> {
  if (!ids.length) return new Set()
  const marks = ids.map(() => '?').join(',')
  const found = new Set<string>()
  for (const r of allRows(h.db, `SELECT id, node_id FROM central_agents WHERE node_id IN (${marks}) OR ('c-' || id) IN (${marks})`, ...ids, ...ids)) {
    found.add(String(r.node_id ?? ''))
    found.add(`c-${String(r.id)}`)
  }
  return found
}

/** Paginated board nodes plus every project (for the filter); status is read for the returned page only. */
export async function nodesView(h: Ca2Handle, q: URLSearchParams, deps: BoardDeps = LIVE_BOARD): Promise<RouteResult> {
  const page = pageOf(q)
  if (!page) return { status: 400, body: { error: 'invalid_page' } }
  const workspaces = listWorkspaces()
  if (workspaces === null) return { status: FEATURE_OFF, body: { error: 'workspaces_off' } }
  const projectOf = new Map(allRows(h.db, 'SELECT id, workspace_id FROM project').map((r) => [String(r.workspace_id), String(r.id)]))
  const projects = workspaces.filter((w) => w.id).map((w) => ({ id: projectOf.get(w.id as string) ?? (w.id as string), workspaceId: w.id as string, name: text(w.name) }))
  const wanted = q.get('projectId')?.trim()
  const candidates = projects.filter((p) => !wanted || p.id === wanted).flatMap((p) => {
    const stored = workspaces.find((w) => w.id === p.workspaceId)?.nodes
    const nodes = (Array.isArray(stored) ? stored : []) as StoredNode[]
    const named = withNodeNames(nodes.map((n) => ({ id: String(n.id), name: typeof n.name === 'string' ? n.name : undefined })))
    return nodes.flatMap((n, i) => (isClaudeNode(n) ? [{ project: p, node: n, id: named[i].id, name: named[i].name }] : []))
  })
  const central = centralNodes(h, candidates.map((c) => c.id))
  const shown = candidates.filter((c) => !central.has(c.id)).slice(page.offset, page.offset + page.limit)
  const needs = { pty: shown.some((c) => c.node.kind === 'agent'), chat: shown.some((c) => c.node.kind === 'agentChat') }
  const [sessions, chats] = await Promise.all([needs.pty ? deps.sessions() : null, needs.chat ? deps.chats() : null])
  const items = shown.map(({ project, node, id, name }) => {
    let live = false
    let status: string | null = null
    if (node.kind === 'agentChat' && chats) {
      const c = chats.snapshot(project.workspaceId, id)
      live = c.live
      status = c.status
    } else if (sessions) {
      const ids = sessionIdsOf(node.panes, id)
      live = ids.some((x) => sessions.isLive(x))
      status = sessions.statusOf(ids.find((x) => sessions.isLive(x)) ?? ids[0]) ?? null
    }
    const title = typeof node.title === 'string' && node.title ? node.title : name
    return { nodeId: id, workspaceId: project.workspaceId, projectId: project.id, projectName: project.name, kind: String(node.kind), title: text(title), live, status }
  })
  return { status: 200, body: { items, projects: projects.map(({ id, name }) => ({ id, name })) } }
}
