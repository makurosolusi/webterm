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

/** Bentuk jamak khusus header seksi. Terpisah dari `NODE_KIND_LABEL` karena peta itu masih dipakai
 *  sebagai meta per baris, di mana yang dinamai cuma satu node. */
const NODE_KIND_PLURAL: Record<WsNodeKind, string> = {
  terminal: 'Terminals',
  agent: 'Agents',
  files: 'Files',
  editor: 'Editors',
}

/** Urutan seksi dipaku, bukan mengikuti isi board: node agent paling sering ditindaklanjuti,
 *  terminal berikutnya, editor/files cuma artefak statis. Urutan yang bergeser mengikuti isi
 *  memaksa mata mencari ulang tiap kali ada node baru. */
const NODE_KIND_ORDER: WsNodeKind[] = ['agent', 'terminal', 'editor', 'files']

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

export interface NodeGroup {
  kind: WsNodeKind
  /** Siap tampil sebagai header seksi, bentuk jamak: 'Agents' | 'Terminals' | 'Editors' | 'Files'. */
  label: string
  rows: NodeRowVM[]
}

/**
 * Semua node di semua workspace, dikelompokkan per kind; di dalam grup workspace aktif lebih dulu,
 * lalu alfabet. Daftar datar lintas kind menyelipkan file editor di antara dua node agent, dan
 * satu-satunya pembedanya cuma meta kecil di bawah judul.
 *
 * Grup kosong dibuang — beda dengan tab Status yang menahan header kosong demi posisi tetap; di
 * sini tak ada posisi yang perlu dijaga.
 *
 * Untuk workspace aktif, `liveActiveNodes` adalah kebenaran — snapshot `workspaces` hanya
 * di-refresh saat workspace dibuat, jadi node yang baru ditambahkan atau baru diganti judulnya
 * hanya ada di canvas. Alasan yang sama dengan `nodesOf` di `./sessionList`.
 */
export function buildNodeGroups(
  workspaces: Workspace[],
  liveActiveNodes: WsNode[] | null,
  activeId: string | null,
  filter: string,
): NodeGroup[] {
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

  return NODE_KIND_ORDER.map((kind) => ({
    kind,
    label: NODE_KIND_PLURAL[kind],
    rows: rows.filter((r) => r.kind === kind),
  })).filter((g) => g.rows.length > 0)
}
