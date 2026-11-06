// Kejadian log workspace/node. Hanya id, hitungan, dan jenis node: nama workspace/node, cwd, dan
// perintah peluncuran adalah isian pengguna dan tidak dicatat.
import { basename } from 'node:path'
import type { Workspace } from '../shared/workspace'
import { createLogger } from './logs'

const log = createLogger('workspace')

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
  /** Gagal menyimpan ke SQLite; error asal tetap dilempar ulang oleh pemanggil. */
  failed(op: 'create' | 'save' | 'delete', workspaceId: string | undefined, err: unknown): void {
    log.error('workspace.db.error', `Workspace ${op} failed`, {
      ids: workspaceId ? { workspaceId } : undefined,
      error: err instanceof Error ? err.name : 'unknown',
      code: (err as { code?: unknown } | null)?.code,
    })
  },
}
