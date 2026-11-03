// Daftar node untuk tab "Nodes" di sidebar: semua node di board yang SEDANG DIBUKA, bukan hanya
// node sesi. Itu bedanya dengan `./sessionList` dan `./closedHistory`, yang sengaja membuang
// 'files'/'editor' karena keduanya bukan shell. Di sini justru itu intinya: tab ini pintu untuk
// memusatkan canvas ke node APA PUN, jadi membuangnya akan membuat node files/editor tak pernah
// bisa dituju. Pindah antar proyek bukan tugas tab ini — itu rumahnya tab Project.
import { sessionLabel } from './sessionList'
import { folderTitle } from './fileBrowse'
import { fileBaseName } from './editorFile'
import type { Workspace, WsNode, WsNodeKind } from '../shared/workspace'

export const NODE_KIND_LABEL: Record<WsNodeKind, string> = {
  terminal: 'Terminal',
  agent: 'Agent',
  files: 'Files',
  editor: 'Editor',
  browser: 'Browser',
}

/** Jamaknya menamai HIMPUNAN: header seksi, dan lewat itu haystack filter. Tetap terpisah karena
 *  `NODE_KIND_LABEL` menamai SATU node — rantai fallback judul di `nodeRowLabel` untuk files/editor
 *  tanpa path. Satu peta saja berarti node editor tanpa path bernama 'Editors'. */
const NODE_KIND_PLURAL: Record<WsNodeKind, string> = {
  terminal: 'Terminals',
  agent: 'Agents',
  files: 'Files',
  editor: 'Editors',
  browser: 'Browsers',
}

/** Urutan seksi dipaku, bukan mengikuti isi board: node agent paling sering ditindaklanjuti,
 *  terminal berikutnya, editor/files cuma artefak statis. Urutan yang bergeser mengikuti isi
 *  memaksa mata mencari ulang tiap kali ada node baru. */
const NODE_KIND_ORDER: WsNodeKind[] = ['agent', 'terminal', 'browser', 'editor', 'files']

export interface NodeRowVM {
  id: string
  label: string
  kind: WsNodeKind
  /** Path yang diwakili node: cwd shell, direktori files, atau file editor. */
  detail?: string
  workspaceName: string
}

/** Nama node seperti yang dilihat pengguna di chrome-nya. Tiap kind memakai rantai fallback milik
 *  komponennya sendiri (`FilesNode` → `folderTitle`, `EditorNode` → `fileBaseName`, sisanya
 *  `sessionLabel`), supaya satu node tidak bernama dua hal di dua tempat. */
export function nodeRowLabel(n: WsNode): string {
  const title = n.title?.trim()
  if (title) return title
  if (n.kind === 'files') return n.dirPath ? folderTitle(n.dirPath) : NODE_KIND_LABEL.files
  if (n.kind === 'editor') return n.filePath ? fileBaseName(n.filePath) : NODE_KIND_LABEL.editor
  if (n.kind === 'browser') return NODE_KIND_LABEL.browser
  return sessionLabel(n)
}

function detailOf(n: WsNode): string | undefined {
  if (n.kind === 'files') return n.dirPath
  if (n.kind === 'editor') return n.filePath
  if (n.kind === 'browser') return n.url
  return n.cwd
}

function toRow(n: WsNode, ws: Workspace): NodeRowVM {
  return {
    id: n.id,
    label: nodeRowLabel(n),
    kind: n.kind,
    detail: detailOf(n),
    workspaceName: ws.name,
  }
}

/** Kind masuk haystack dalam bentuk JAMAK karena itu yang terbaca pengguna di header seksi;
 *  mengetik "Agents" tidak boleh menghasilkan nol baris. Bentuk tunggalnya ikut tercakup gratis
 *  karena ia prefiks dari jamaknya ('agent' ⊂ 'agents'), jadi satu bentuk saja cukup. */
function matches(row: NodeRowVM, needle: string): boolean {
  const hay = `${row.label} ${NODE_KIND_PLURAL[row.kind]} ${row.detail ?? ''} ${row.workspaceName}`
  return hay.toLowerCase().includes(needle)
}

export interface NodeGroup {
  kind: WsNodeKind
  /** Siap tampil sebagai header seksi, bentuk jamak: 'Agents' | 'Terminals' | 'Editors' | 'Files'. */
  label: string
  rows: NodeRowVM[]
}

/**
 * Node workspace AKTIF saja, dikelompokkan per kind, alfabet case-insensitive di dalam grup.
 * Daftar lintas-workspace membuat seksi "Agents 3" memuat node tiga proyek yang hanya dibedakan
 * teks kecil di bawah judul — pengguna membacanya sebagai tiga agent di proyek yang sedang dibuka.
 *
 * Grup kosong dibuang — beda dengan tab Status yang menahan header kosong demi posisi tetap; di
 * sini tak ada posisi yang perlu dijaga.
 *
 * Bila ada, `liveActiveNodes` adalah kebenaran — snapshot `workspaces` hanya di-refresh saat
 * workspace dibuat, jadi node yang baru ditambahkan atau baru diganti judulnya hanya ada di
 * canvas. Alasan yang sama dengan `nodesOf` di `./sessionList`. `workspaces` tetap dibutuhkan
 * untuk nama board-nya, yang ikut jadi bahan filter.
 */
export function buildNodeGroups(
  workspaces: Workspace[],
  liveActiveNodes: WsNode[] | null,
  activeId: string | null,
  filter: string,
): NodeGroup[] {
  // `activeId` null = belum ada board terpilih; tak ada yang bisa didaftar, bukan kondisi error.
  const active = workspaces.find((ws) => ws.id === activeId)
  if (!active) return []

  const needle = filter.trim().toLowerCase()
  const rows = (liveActiveNodes ?? active.nodes)
    .map((n) => toRow(n, active))
    .filter((r) => !needle || matches(r, needle))
  rows.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()))

  return NODE_KIND_ORDER.map((kind) => ({
    kind,
    label: NODE_KIND_PLURAL[kind],
    rows: rows.filter((r) => r.kind === kind),
  })).filter((g) => g.rows.length > 0)
}
