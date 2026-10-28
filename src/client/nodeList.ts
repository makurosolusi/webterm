// Daftar node untuk tab "Nodes" di sidebar: SEMUA node di board, bukan hanya node sesi.
// Itu bedanya dengan `./sessionList` dan `./closedHistory`, yang sengaja membuang 'files'/'editor'
// karena keduanya bukan shell. Di sini justru itu intinya: tab ini pintu untuk memusatkan canvas
// ke node APA PUN, jadi membuangnya akan membuat node files/editor tak pernah bisa dituju.
import { sessionLabel } from './sessionList'
import { folderTitle } from './fileBrowse'
import { fileBaseName } from './editorFile'
import type { Workspace, WsNode, WsNodeKind } from '../shared/workspace'

export const NODE_KIND_LABEL: Record<WsNodeKind, string> = {
  terminal: 'Terminal',
  agent: 'Agent',
  files: 'Files',
  editor: 'Editor',
}

export interface NodeRowVM {
  id: string
  label: string
  kind: WsNodeKind
  /** Path yang diwakili node: cwd shell, direktori files, atau file editor. */
  detail?: string
  workspaceId: string
  workspaceName: string
  isActive: boolean
}

/** Nama node seperti yang dilihat pengguna di chrome-nya. Tiap kind memakai rantai fallback milik
 *  komponennya sendiri (`FilesNode` → `folderTitle`, `EditorNode` → `fileBaseName`, sisanya
 *  `sessionLabel`), supaya satu node tidak bernama dua hal di dua tempat. */
export function nodeRowLabel(n: WsNode): string {
  const title = n.title?.trim()
  if (title) return title
  if (n.kind === 'files') return n.dirPath ? folderTitle(n.dirPath) : NODE_KIND_LABEL.files
  if (n.kind === 'editor') return n.filePath ? fileBaseName(n.filePath) : NODE_KIND_LABEL.editor
  return sessionLabel(n)
}

function detailOf(n: WsNode): string | undefined {
  if (n.kind === 'files') return n.dirPath
  if (n.kind === 'editor') return n.filePath
  return n.cwd
}

function toRow(n: WsNode, ws: Workspace, isActive: boolean): NodeRowVM {
  return {
    id: n.id,
    label: nodeRowLabel(n),
    kind: n.kind,
    detail: detailOf(n),
    workspaceId: ws.id,
    workspaceName: ws.name,
    isActive,
  }
}

function matches(row: NodeRowVM, needle: string): boolean {
  const hay = `${row.label} ${NODE_KIND_LABEL[row.kind]} ${row.detail ?? ''} ${row.workspaceName}`
  return hay.toLowerCase().includes(needle)
}

/**
 * Semua node di semua workspace, workspace aktif lebih dulu.
 *
 * Untuk workspace aktif, `liveActiveNodes` adalah kebenaran — snapshot `workspaces` hanya
 * di-refresh saat workspace dibuat, jadi node yang baru ditambahkan atau baru diganti judulnya
 * hanya ada di canvas. Alasan yang sama dengan `nodesOf` di `./sessionList`.
 */
export function buildNodeList(
  workspaces: Workspace[],
  liveActiveNodes: WsNode[] | null,
  activeId: string | null,
  filter: string,
): NodeRowVM[] {
  const needle = filter.trim().toLowerCase()
  const ordered = [...workspaces].sort(
    (a, b) => Number(b.id === activeId) - Number(a.id === activeId),
  )

  const rows: NodeRowVM[] = []
  for (const ws of ordered) {
    const isActive = ws.id === activeId
    const nodes = isActive && liveActiveNodes ? liveActiveNodes : ws.nodes
    const group = nodes
      .map((n) => toRow(n, ws, isActive))
      .filter((r) => !needle || matches(r, needle))
    group.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
    rows.push(...group)
  }
  return rows
}
