// Kejadian log workspace/node. Hanya id, hitungan, dan jenis node: nama workspace/node, cwd, dan
// perintah peluncuran adalah isian pengguna dan tidak dicatat.
import { basename } from 'node:path'
import type { Workspace } from '../shared/workspace'
import type { PreservedNode } from '../shared/workspace.schema'
import { createLogger } from './logs'

const log = createLogger('workspace')
const MAX_LOGGED_ISSUES = 5
const MAX_LOGGED_KIND = 40 // a hand-edited kind can be any string: cap what reaches the log

/** Bandingkan `prev` (null = baru) dengan `next` lalu catat create/rename/node/layout/save. */
export function logWorkspaceSave(prev: Workspace | null, next: Workspace): void {
  const ids = { workspaceId: next.id }
  if (prev && prev.name !== next.name) log.info('workspace.rename', 'Workspace renamed', { ids })
  const before = new Map((prev?.nodes ?? []).map((n) => [n.id, n]))
  const after = new Map(next.nodes.map((n) => [n.id, n]))
  for (const [nodeId, n] of after) {
    if (!before.has(nodeId)) log.info('node.create', 'Node added', { ids: { ...ids, nodeId }, kind: n.kind, agentId: n.agentId })
  }
  for (const [nodeId, n] of before) {
    if (!after.has(nodeId)) log.info('node.delete', 'Node removed', { ids: { ...ids, nodeId }, kind: n.kind })
  }
  if (prev && JSON.stringify(prev.viewport) !== JSON.stringify(next.viewport)) {
    log.debug('layout.save', 'Viewport saved', { ids, zoom: next.viewport.zoom })
  }
  log.debug('workspace.save', 'Workspace saved', { ids, nodes: next.nodes.length, bridges: next.bridges.length })
}

export const workspaceLog = {
  created(ws: Workspace): void {
    log.info('workspace.create', 'Workspace created', { ids: { workspaceId: ws.id }, cwd: ws.cwd ? basename(ws.cwd) : undefined })
  },
  deleted(workspaceId: string): void {
    log.info('workspace.delete', 'Workspace deleted', { ids: { workspaceId } })
  },
  activated(workspaceId: string): void {
    log.debug('workspace.activate', 'Active workspace set', { ids: { workspaceId } })
  },
  /** A save refused: the stored board is newer than the writer's base, or the row is gone. */
  refused(workspaceId: string, reason: 'stale' | 'missing'): void {
    log.info('workspace.save.refused', `Workspace save refused: ${reason}`, { ids: { workspaceId } })
  },
  /** A stored row needed the schema's repair on read (bad blob/node dropped). Issues name fields only, never values. */
  repaired(workspaceId: string, issues: string[]): void {
    log.warn('workspace.row.repaired', 'Stored workspace row failed validation; served a repaired board', {
      ids: { workspaceId }, issues: issues.slice(0, MAX_LOGGED_ISSUES), issueCount: issues.length,
    })
  },
  /** Stored nodes this build cannot read: hidden from the served board, kept in the row. Count and kinds only. */
  nodesPreserved(workspaceId: string, nodes: readonly PreservedNode[]): void {
    const kinds = [...new Set(nodes.map((n) => (typeof n.kind === 'string' ? n.kind.slice(0, MAX_LOGGED_KIND) : '(none)')))]
    log.warn('workspace.nodes.preserved', 'Unreadable nodes are hidden from the board and preserved in storage', {
      ids: { workspaceId }, count: nodes.length, kinds: kinds.slice(0, MAX_LOGGED_ISSUES),
    })
  },
  /** A post-commit side effect (log/event/guard) threw; the write already succeeded and keeps its status. */
  sideEffectFailed(step: string, workspaceId: string, err: unknown): void {
    log.error('workspace.sideeffect.error', `Workspace ${step} after commit failed`, {
      ids: { workspaceId }, error: err instanceof Error ? err.name : 'unknown',
    })
  },
  /** Gagal menyimpan ke SQLite; error asal tetap dilempar ulang oleh pemanggil. */
  failed(op: 'create' | 'save' | 'delete', workspaceId: string | undefined, err: unknown): void {
    log.error('workspace.db.error', `Workspace ${op} failed`, {
      ids: workspaceId ? { workspaceId } : undefined,
      error: err instanceof Error ? err.name : 'unknown',
      code: (err as { code?: unknown } | null)?.code,
    })
  },
}
