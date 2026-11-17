// Logika murni di balik panel daftar sesi (sidebar kiri): pengelompokan, pengurutan, pelabelan,
// dan pencocokan filter. Daftar sesi
// `src/renderer/lib/sidebarFilter.ts`. Semua di sini bebas DOM supaya bisa dites di node-env.
//
// Tanda `unread` datang dari `./unread` — murni sisi klien, diturunkan dari kanal status dan BUKAN
// dari protokol (`StatusMsg` hanya membawa `AgentStatus`). Modul ini tidak membacanya sendiri:
// himpunan id unread disuntikkan sebagai argumen supaya di sini tetap bebas state global.
//
// Yang SENGAJA tidak ada, beserta alasannya (bukan kelalaian):
// - Frame group canvas (`kind: 'group'`). `WsNodeKind` webterm tidak punya frame, jadi pohonnya
//   dua tingkat (workspace → sesi), bukan rekursif.
// Status meaning (bucket, label, glyph) is NOT decided here: every row reads `sessionStatusView`
// (`./sessionStatus.model`), the one model shared with node tabs, the layers panel and node headers.
import type { AgentId, AgentStatus, Workspace, WsNode, WsNodeKind } from '../shared/workspace'
import type { StatusReason } from '../shared/protocol'
import type { NodeStatusInfo } from '../shared/nodeStatusBar'
import { BUCKET_LABEL, BUCKET_ORDER, sessionStatusView, type StatusBucket, type StatusView } from './sessionStatus.model'
import { agentConfig } from '../shared/workspace'
import { isAutoName } from './nodeIdentity'
import { withNodeName } from './nodeName.label'
import { AGENT_CHAT_TITLE } from '../shared/agentChat.node'
import { workspaceColorVar } from '../shared/workspaceColor'

/** Kind node yang dihitung sebagai "sesi". `files`/`editor` adalah penampil, bukan shell —
 *  Hanya mendaftar node terminal di sidebar-nya. `agentChat` is a Claude session
 *  without a terminal, so it is listed (and reopenable) like an agent node. */
export const SESSION_KINDS: readonly WsNodeKind[] = ['terminal', 'agent', 'agentChat']

/** Mode pengelompokan tingkat atas pada sidebar. */
export type SidebarGrouping = 'project' | 'status'

/** Default untuk pemanggil yang tidak peduli unread (mis. tab workspace, yang hanya butuh dot
 *  status). Dibagi satu instance: himpunan ini tidak pernah ditulis. */
const NO_UNREAD: ReadonlySet<string> = new Set()

/** What a row's status is read from besides the hook status map: the live attention reasons
 *  (`useStatusReasons`) and the server facts (`useNodeStatusFactsMap`: exit, statusSince). */
export interface StatusSources {
  reasons?: Record<string, StatusReason>
  facts?: Record<string, NodeStatusInfo>
}

/** Title of a session without its node name. Same fallback chain as `AgentNode`
 *  (`d.title ?? builtin?.label ?? agentId`), so one node is not called two things; a legacy
 *  generated `<adjective>-<noun>` title counts as absent there too. */
export function sessionTitle(n: Pick<WsNode, 'title' | 'agentId' | 'kind'>): string {
  const title = isAutoName(n.title) ? undefined : n.title?.trim()
  if (title) return title
  // An Agent Chat also carries `agentId: 'claude'`, but its chrome names it "Agent Chat", not the agent.
  if (n.kind === 'agentChat') return AGENT_CHAT_TITLE
  if (n.agentId) return agentConfig(n.agentId)?.label ?? n.agentId
  return n.kind === 'agent' ? 'Agent' : 'Terminal'
}

/** Sidebar / Reopen label: `Mango · Deploy` (node name, then `sessionTitle`). */
export function sessionLabel(n: Pick<WsNode, 'name' | 'title' | 'agentId' | 'kind'>): string {
  return withNodeName(n.name, sessionTitle(n))
}

/** Nama folder terakhir dari sebuah path — cwd penuh tidak muat di baris selebar 300px. */
export function dirName(p: string | undefined): string {
  if (!p) return ''
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/**
 * Baris meta di bawah judul sesi: nama workspace (hanya bila barisnya perlu menyebutnya) lalu
 * folder cwd-nya. Duplikat dibuang karena menamai workspace sama dengan foldernya adalah kebiasaan,
 * bukan kecelakaan — board `wibu` di `~/dev/wibu` akan keluar sebagai `wibu · wibu`, yang terbaca
 * seperti bug padahal cuma satu fakta yang disebut dua kali. Urutan dipertahankan: nama workspace
 * adalah konteks yang lebih luas, jadi ia tetap di depan folder.
 */
export function rowMeta(projectName: string | undefined, cwd: string | undefined): string[] {
  return [...new Set([projectName?.trim() ?? '', dirName(cwd)].filter(Boolean))]
}

/** Kunci disclosure untuk baris workspace. */
export function projectCollapseKey(projectId: string): string {
  return `project:${projectId}`
}

/**
 * Apakah baris workspace sedang terlipat? MURNI pilihan pengguna, tanpa override berarti terbuka.
 * SENGAJA tidak lagi diturunkan dari "apakah workspace ini aktif": begitu keadaan lipatan ikut
 * `isActive`, mengklik header board lain melipat board yang tadinya aktif padahal pengguna tak
 * pernah menutupnya.
 */
export function isProjectCollapsed(overrides: Record<string, boolean>, key: string): boolean {
  return overrides[key] ?? false
}

/**
 * Peta lipatan dari localStorage. Isinya tulisan sesi sebelumnya — bisa korup, bisa dari versi
 * lain — jadi apa pun yang bukan objek boolean jatuh ke `{}` alih-alih melempar dan merobohkan
 * panel. Nilai non-boolean dibuang supaya tipe kembaliannya bukan janji palsu.
 */
export function parseCollapsed(raw: string | null): Record<string, boolean> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'boolean') out[key] = value
    return out
  } catch {
    return {}
  }
}

/** Header badges: how many sessions need you now, and how many are working. */
export interface SignalCounts {
  attention: number
  working: number
}

export function signalCounts(rows: SessionRowVM[]): SignalCounts {
  let attention = 0
  let working = 0
  for (const r of rows) {
    if (r.view.bucket === 'needs-input') attention++
    else if (r.view.bucket === 'working') working++
  }
  return { attention, working }
}

export interface SessionRowVM {
  id: string
  label: string
  /** The node's own title (what Rename edits), without the node name prefix. */
  title: string
  color?: string
  agentId?: AgentId
  /** Drives the row's kind icon (`KIND_ICON`): Claude Code, Agent Chat and Terminal differ. */
  kind: WsNodeKind
  /** The shared status model's view of this session (bucket, glyph, label, unread, since). */
  view: StatusView
  cwd?: string
  /** Workspace pemilik baris. Selalu terisi: callback tutup/fokus webterm butuh id ini di KEDUA
   *  mode. Komponen yang memutuskan kapan nama workspace ikut dirender. */
  projectId: string
  projectName: string
  projectColor?: string
}

export interface SessionGroup {
  projectId: string
  projectName: string
  projectColor?: string
  cwd?: string
  isActive: boolean
  sessions: SessionRowVM[]
}

/** One Status-tab section: sessions of EVERY workspace in one lifecycle bucket. */
export interface StatusSection {
  bucket: StatusBucket
  label: string
  rows: SessionRowVM[]
}

export const isSession = (n: WsNode): boolean => SESSION_KINDS.includes(n.kind)

function toRow(
  n: WsNode,
  status: AgentStatus | undefined,
  ws: Workspace,
  unread: ReadonlySet<string>,
  src: StatusSources,
): SessionRowVM {
  const facts = src.facts?.[n.id]
  // The live channel's reason wins; the fetched one counts only while it describes the same status.
  const reason = src.reasons?.[n.id] ?? (facts?.reason && facts.status === status ? { reason: facts.reason, detail: facts.detail } : undefined)
  return {
    id: n.id,
    label: sessionLabel(n),
    title: sessionTitle(n),
    color: n.color ?? (n.agentId ? agentConfig(n.agentId)?.color : undefined),
    agentId: n.agentId,
    kind: n.kind,
    view: sessionStatusView({ status, ...reason, exit: facts?.exit, unread: unread.has(n.id), since: facts?.statusSince ?? facts?.startedAt }),
    cwd: n.cwd ?? ws.cwd,
    projectId: ws.id,
    projectName: ws.name,
    projectColor: ws.color ? workspaceColorVar(ws.color, ws.colorShade) : undefined,
  }
}

/** Every session id the side bar lists (for the one batched facts fetch). */
export function sessionIds(workspaces: Workspace[], liveActiveNodes: WsNode[] | null, activeProjectId: string | null): string[] {
  return [...new Set(workspaces.flatMap((ws) => nodesOf(ws, liveActiveNodes, ws.id === activeProjectId).map((n) => n.id)))]
}

// Dicocokkan: nama sesi + cwd — dua hal yang BARIS ITU tampilkan. Tidak mencocokkan
// nama sesi provider; webterm tidak punya nama sesi provider, dan cwd adalah identitas lain barisnya.
function matches(row: SessionRowVM, needle: string): boolean {
  return `${row.label} ${row.cwd ?? ''}`.toLowerCase().includes(needle)
}

/** Apakah WORKSPACE-nya sendiri yang menjawab needle? Mengetik nama workspace harus memunculkan
 *  workspace itu UTUH — pengguna mengetik nama wadahnya, jadi yang diminta adalah wadahnya. */
function projectMatches(ws: Workspace, needle: string): boolean {
  return `${ws.name} ${ws.cwd ?? ''}`.toLowerCase().includes(needle)
}

function matchedProjectIds(workspaces: Workspace[], needle: string): Set<string> {
  const ids = new Set<string>()
  if (!needle) return ids
  for (const ws of workspaces) if (projectMatches(ws, needle)) ids.add(ws.id)
  return ids
}

/**
 * Node milik sebuah workspace, dengan node LIVE menang untuk workspace aktif.
 *
 * Snapshot `workspaces` di client hanya di-refresh saat workspace dibuat, sedangkan canvas aktif
 * berubah tiap edit — jadi untuk workspace aktif, `liveActiveNodes` adalah kebenaran untuk
 * judul/status, dan node baru yang belum tersimpan hanya ada di sana.
 */
function nodesOf(ws: Workspace, liveActiveNodes: WsNode[] | null, isActive: boolean): WsNode[] {
  // Untuk workspace aktif, canvas adalah satu-satunya kebenaran: node tersimpan yang tak lagi
  // ada di sana sudah dihapus pengguna, jadi JANGAN digabung kembali dari snapshot.
  if (isActive && liveActiveNodes) return liveActiveNodes.filter(isSession)
  return ws.nodes.filter(isSession)
}

export function buildSessionList(
  workspaces: Workspace[],
  liveActiveNodes: WsNode[] | null,
  activeProjectId: string | null,
  statuses: Record<string, AgentStatus>,
  filter: string,
  // Opsional, default "tak ada yang unread": mode project tidak punya section Unread, jadi
  // pemanggil yang hanya butuh grup per workspace tak perlu tahu soal kanal baca sama sekali.
  unread: ReadonlySet<string> = NO_UNREAD,
  src: StatusSources = {},
): SessionGroup[] {
  const needle = filter.trim().toLowerCase()
  const nameMatched = matchedProjectIds(workspaces, needle)

  const groups: SessionGroup[] = workspaces.map((ws) => {
    const isActive = ws.id === activeProjectId
    const projectMatched = nameMatched.has(ws.id)
    const keep = (r: SessionRowVM): boolean => !needle || projectMatched || matches(r, needle)
    return {
      projectId: ws.id,
      projectName: ws.name,
      projectColor: ws.color ? workspaceColorVar(ws.color, ws.colorShade) : undefined,
      cwd: ws.cwd,
      isActive,
      // Urutan array node, BUKAN aktif-dulu: sidebar mencerminkan urutan canvas.
      sessions: nodesOf(ws, liveActiveNodes, isActive)
        .map((n) => toRow(n, statuses[n.id], ws, unread, src))
        .filter(keep),
    }
  })

  // Workspace yang NAMANYA sendiri cocok tetap muncul walau kosong — pengguna mengetik nama
  // wadahnya, jadi menghilangkannya terasa seperti bug.
  return needle
    ? groups.filter((g) => nameMatched.has(g.projectId) || g.sessions.length > 0)
    : groups
}

export function buildStatusList(
  workspaces: Workspace[],
  liveActiveNodes: WsNode[] | null,
  activeProjectId: string | null,
  statuses: Record<string, AgentStatus>,
  filter: string,
  unread: ReadonlySet<string> = NO_UNREAD,
  src: StatusSources = {},
): StatusSection[] {
  const needle = filter.trim().toLowerCase()
  const nameMatched = matchedProjectIds(workspaces, needle)

  // Mode status meruntuhkan dinding workspace, jadi aturan "workspace cocok → utuh" berlaku
  // PER BARIS. `seen` menutup jendela duplikasi saat berpindah workspace: `activeProjectId`
  // berganti seketika sementara `liveActiveNodes` masih memegang node workspace SEBELUMNYA,
  // sehingga satu node bisa terpancar dua kali di bawah dua workspace.
  const tagged: { row: SessionRowVM; pidx: number }[] = []
  const seen = new Set<string>()
  workspaces.forEach((ws, pidx) => {
    const isActive = ws.id === activeProjectId
    for (const n of nodesOf(ws, liveActiveNodes, isActive)) {
      if (seen.has(n.id)) continue
      seen.add(n.id)
      const row = toRow(n, statuses[n.id], ws, unread, src)
      if (!needle || nameMatched.has(ws.id) || matches(row, needle)) tagged.push({ row, pidx })
    }
  })

  // Inside a bucket: unread first (Linear/ChatGPT: new for you on top), then workspace order and
  // title, so a row only moves when its own state changes.
  const rank = (a: { row: SessionRowVM; pidx: number }, b: { row: SessionRowVM; pidx: number }) =>
    Number(b.row.view.unread) - Number(a.row.view.unread) ||
    a.pidx - b.pidx ||
    a.row.label.toLowerCase().localeCompare(b.row.label.toLowerCase())
  // Fixed lifecycle order (Needs input -> Working -> Idle -> Error -> Exited); empty buckets are
  // left out, like VS Code SCM hides empty groups. There is no "No status": the model always has one.
  return BUCKET_ORDER.map((bucket) => ({
    bucket,
    label: BUCKET_LABEL[bucket],
    rows: tagged.filter((t) => t.row.view.bucket === bucket).sort(rank).map((t) => t.row),
  })).filter((s) => s.rows.length > 0)
}

/** Arti sebuah keydown di dalam field filter. */
export type SidebarFilterKeyAction = 'clear' | 'ignore'

/**
 * Escape membersihkan filter dalam SATU aksi — tapi HANYA selagi ada teks. Pada field kosong ia
 * `ignore`, sehingga tombol itu masih sampai ke pemilik berikutnya dan field tidak menjadi jalan
 * buntu untuk satu tombol yang justru dipakai orang untuk mundur.
 */
export function sidebarFilterKeyAction(key: string, filter: string): SidebarFilterKeyAction {
  return key === 'Escape' && filter !== '' ? 'clear' : 'ignore'
}

/** Kalimat mana (kalau ada) yang harus ditampilkan daftar kosong. `loading` = workspaces not
 *  hydrated yet: nothing is shown, so boot never flashes "No sessions yet". */
export type SidebarEmptyState = 'none' | 'loading' | 'no-sessions' | 'no-matches'

/** Groups of every workspace except the open one (the activity bar's Sessions badge counts these). */
export const otherWorkspaceGroups = (groups: SessionGroup[]): SessionGroup[] => groups.filter((g) => !g.isActive)

/** "Tidak ada apa-apa di sini" dan "tidak ada yang cocok" adalah dua fakta berbeda, dan hanya
 *  yang kedua punya undo. Filter bertahan selama bekerja, jadi daftar yang kosong karena filter
 *  lama harus mengatakannya — bukan terbaca seperti sidebar yang rusak. */
export function sidebarEmptyState(noRows: boolean, filter: string, loading = false): SidebarEmptyState {
  if (!noRows) return 'none'
  if (filter.trim() !== '') return 'no-matches'
  return loading ? 'loading' : 'no-sessions'
}
