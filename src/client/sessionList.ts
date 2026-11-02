// Logika murni di balik panel daftar sesi (sidebar kiri): pengelompokan, pengurutan, pelabelan,
// dan pencocokan filter. Porting dari nodeterm v0.4.5 `src/renderer/lib/sessionList.ts` +
// `src/renderer/lib/sidebarFilter.ts`. Semua di sini bebas DOM supaya bisa dites di node-env.
//
// Tanda `unread` datang dari `./unread` — murni sisi klien, diturunkan dari kanal status dan BUKAN
// dari protokol (`StatusMsg` hanya membawa `AgentStatus`). Modul ini tidak membacanya sendiri:
// himpunan id unread disuntikkan sebagai argumen supaya di sini tetap bebas state global.
//
// Yang DIBUANG dari nodeterm, beserta alasannya (bukan kelalaian):
// - Frame group canvas (`kind: 'group'`). `WsNodeKind` webterm tidak punya frame, jadi pohonnya
//   dua tingkat (workspace → sesi), bukan rekursif.
// - Jam status (`lastEventAt` / `lastSeen`). Status webterm tidak membawa timestamp, jadi urutan
//   di dalam satu section memakai (urutan workspace, judul) alih-alih "transisi terbaru dulu".
import type { AgentId, AgentStatus, Workspace, WsNode, WsNodeKind } from '../shared/workspace'
import { agentConfig } from '../shared/workspace'

/** Kind node yang dihitung sebagai "sesi". `files`/`editor` adalah penampil, bukan shell —
 *  nodeterm juga hanya mendaftar node terminal di sidebar-nya. */
export const SESSION_KINDS: readonly WsNodeKind[] = ['terminal', 'agent']

export type StatusKind = 'working' | 'attention' | 'done' | 'unknown'

/** Mode pengelompokan tingkat atas pada sidebar. */
export type SidebarGrouping = 'project' | 'status' | 'nodes'

// Vokabuler manusiawi, diambil apa adanya dari nodeterm `STATE_LABEL`. Bukan enum huruf besar:
// label ini dibaca manusia di tooltip dot dan di ringkasan baris.
export const STATE_LABEL: Record<StatusKind, string> = {
  working: 'Running',
  attention: 'Waiting for your response',
  done: 'Done',
  unknown: 'Unknown',
}

/** Section mode-status. Beda dari `StatusKind` (yang menggerakkan glyph) karena ia juga memantulkan
 *  tanda `unread`: turn selesai yang belum kamu lihat dapat section sendiri supaya mudah dicari,
 *  terpisah dari yang sudah-dibaca-dan-diam. */
export type StatusGroup = 'attention' | 'unread' | 'working' | 'idle' | 'unknown'

// Urutan tampil section pada mode status: yang menuntut kamu dulu, lalu yang BARU untukmu, lalu
// yang hidup, lalu yang sudah diam. Unread duduk tinggi (kedua) supaya hasil yang belum dilihat
// menonjol — walau menurut prioritas keanggotaan sesi yang masih berjalan tetap di Running.
const STATUS_GROUP_ORDER: readonly StatusGroup[] = ['attention', 'unread', 'working', 'idle', 'unknown']

// Header seksi dibaca sebagai kalimat tentang sesi di bawahnya, jadi kosakatanya bukan kosakata
// internal: `unknown` di sini berarti "terminal biasa, belum punya status agent" — "Unknown"
// terbaca seperti kegagalan membaca sesuatu. Peta ini TERPISAH dari `STATE_LABEL` (yang mengisi
// tooltip per baris) justru supaya header bisa bicara lebih longgar dari nama kind-nya.
export const STATUS_GROUP_LABEL: Record<StatusGroup, string> = {
  attention: 'Need attention',
  unread: 'Unread',
  working: 'Running',
  idle: 'Idle',
  unknown: 'No status',
}

/**
 * Kalimat per BARIS, dipilih dari status mentahnya — bukan dari `StatusKind`-nya.
 *
 * `sessionStatusKind` melipat `waiting` dan `blocked` ke satu `attention` karena baris sidebar hanya
 * punya satu slot glyph, dan lipatan itu memang benar untuk glyph-nya ("yang ini mau kamu"). Tapi
 * `stateLabel` bukan glyph: ia mengisi `title` bel DAN `aria-label` barisnya (`SessionRow.tsx`),
 * jadi lewat peta `STATE_LABEL` sebuah turn yang cuma habis ikut mengaku "Waiting for your
 * response" — klaim yang sama palsunya dengan chip NEEDS YOU yang dilaporkan pengguna. Teks punya
 * ruang yang tidak dimiliki glyph, jadi di sinilah perbedaannya dipulihkan.
 */
const AGENT_STATE_LABEL: Partial<Record<AgentStatus, string>> = {
  blocked: 'Blocked — waiting for your approval',
  waiting: 'Turn ended — nothing is blocked',
}

export function stateLabelOf(status: AgentStatus | undefined): string {
  return (status && AGENT_STATE_LABEL[status]) ?? STATE_LABEL[sessionStatusKind(status)]
}

/** Default untuk pemanggil yang tidak peduli unread (mis. tab workspace, yang hanya butuh dot
 *  status). Dibagi satu instance: himpunan ini tidak pernah ditulis. */
const NO_UNREAD: ReadonlySet<string> = new Set()

/**
 * `waiting` dan `blocked` dilipat jadi SATU kind `attention`: keduanya berarti giliranmu, dan
 * baris sidebar hanya punya satu glyph. `done` BUKAN sinyal attention — turn yang selesai adalah
 * status tersendiri (check tenang), bukan bel merah.
 */
export function sessionStatusKind(state: AgentStatus | undefined): StatusKind {
  switch (state) {
    case 'working':
      return 'working'
    case 'waiting':
    case 'blocked':
      return 'attention'
    case 'done':
      return 'done'
    default:
      return 'unknown'
  }
}

/**
 * Section mode-status untuk sebuah baris. Prioritas keanggotaan (match pertama menang) — SENGAJA
 * bukan urutan tampil, yang ditetapkan `STATUS_GROUP_ORDER`: `attention` (kamu harus bertindak) →
 * `working` (turn hidup itu Running, bukan Unread, sama dengan glyph-nya) → `unread` (sudah selesai
 * tapi belum dilihat) → `idle` (selesai dan sudah dilihat) → `unknown` (tak ada sinyal hook).
 * Jadi node bertanda yang turn BARUnya sedang jalan tetap di Running, lalu muncul lagi sebagai
 * Unread begitu turn itu berakhir. `unread` wajib disebut: default diam-diam "sudah dibaca" akan
 * membuat pemanggil yang lupa kehilangan section-nya tanpa pesan.
 */
export function sessionStatusGroup(kind: StatusKind, unread: boolean): StatusGroup {
  if (kind === 'attention') return 'attention'
  if (kind === 'working') return 'working'
  if (unread) return 'unread'
  if (kind === 'done') return 'idle'
  return 'unknown'
}

/** Nama yang dipakai baris sidebar. Rantai fallback-nya sama dengan `AgentNode`
 *  (`d.title ?? builtin?.label ?? agentId`), supaya satu node tidak bernama dua hal. */
export function sessionLabel(n: Pick<WsNode, 'title' | 'agentId' | 'kind'>): string {
  const title = n.title?.trim()
  if (title) return title
  if (n.agentId) return agentConfig(n.agentId)?.label ?? n.agentId
  return 'Terminal'
}

/** Nama folder terakhir dari sebuah path — cwd penuh tidak muat di baris selebar 300px. */
function dirName(p: string | undefined): string {
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

/** Apa yang dilakukan klik kiri pada header workspace — persis SATU dari dua, tidak pernah dua-duanya.
 *  Workspace tidak aktif berpindah; yang aktif melipat dirinya, supaya barisnya tak punya zona mati.
 *  Chevron adalah jalan keluarnya: ia melipat baris APA PUN (menghentikan propagasi). */
export type ProjectHeadAction = 'switch' | 'toggle-collapse'

export function projectHeadClickAction(isActive: boolean): ProjectHeadAction {
  return isActive ? 'toggle-collapse' : 'switch'
}

/** Badge header: berapa sesi menuntut kamu sekarang, dan berapa yang sedang bekerja. */
export interface SignalCounts {
  attention: number
  working: number
}

export function signalCounts(rows: SessionRowVM[]): SignalCounts {
  let attention = 0
  let working = 0
  for (const r of rows) {
    if (r.statusKind === 'attention') attention++
    else if (r.statusKind === 'working') working++
  }
  return { attention, working }
}

export interface SessionRowVM {
  id: string
  label: string
  color?: string
  agentId?: AgentId
  isAgent: boolean
  statusKind: StatusKind
  stateLabel: string
  /** Turn yang berakhir selagi baris ini tidak ditonton. Status KERJA tetap `statusKind` — ini
   *  keadaan BACA, jadi keduanya dibawa terpisah dan glyph-lah yang mendamaikannya.
   *  OPSIONAL (absen = sudah dibaca) demi fixture lain yang hanya menguji dot status dan tak
   *  membaca field ini; `toRow` — satu-satunya pembuat baris di produksi — selalu mengisinya. */
  unread?: boolean
  cwd?: string
  /** Workspace pemilik baris. Selalu terisi (beda dari nodeterm, yang mengisinya hanya di mode
   *  status): callback tutup/fokus webterm butuh id ini di KEDUA mode. Komponen yang memutuskan
   *  kapan nama workspace ikut dirender. */
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

/** Satu section pada mode status: sesi dari SEMUA workspace, diratakan lalu dikelompokkan per
 *  status sehingga yang menuntut perhatian naik ke atas. */
export interface StatusSection {
  kind: StatusGroup
  label: string
  rows: SessionRowVM[]
}

export const isSession = (n: WsNode): boolean => SESSION_KINDS.includes(n.kind)

function toRow(
  n: WsNode,
  status: AgentStatus | undefined,
  ws: Workspace,
  unread: ReadonlySet<string>,
): SessionRowVM {
  const statusKind = sessionStatusKind(status)
  return {
    id: n.id,
    label: sessionLabel(n),
    color: n.color ?? (n.agentId ? agentConfig(n.agentId)?.color : undefined),
    agentId: n.agentId,
    isAgent: !!n.agentId,
    statusKind,
    stateLabel: stateLabelOf(status),
    unread: unread.has(n.id),
    cwd: n.cwd ?? ws.cwd,
    projectId: ws.id,
    projectName: ws.name,
    projectColor: ws.color,
  }
}

// Dicocokkan: nama sesi + cwd — dua hal yang BARIS ITU tampilkan. nodeterm mencocokkan judul +
// nama sesi; webterm tidak punya nama sesi provider, dan cwd adalah identitas lain barisnya.
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
      projectColor: ws.color,
      cwd: ws.cwd,
      isActive,
      // Urutan array node, BUKAN aktif-dulu: sidebar mencerminkan urutan canvas.
      sessions: nodesOf(ws, liveActiveNodes, isActive)
        .map((n) => toRow(n, statuses[n.id], ws, unread))
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
      const row = toRow(n, statuses[n.id], ws, unread)
      if (!needle || nameMatched.has(ws.id) || matches(row, needle)) tagged.push({ row, pidx })
    }
  })

  const byStatus = new Map<StatusGroup, { row: SessionRowVM; pidx: number }[]>()
  for (const t of tagged) {
    const group = sessionStatusGroup(t.row.statusKind, t.row.unread === true)
    const list = byStatus.get(group)
    if (list) list.push(t)
    else byStatus.set(group, [t])
  }
  // Tanpa timestamp status, urutan deterministik adalah (urutan workspace, judul) — bukan
  // "transisi terbaru dulu" seperti nodeterm. Lihat catatan kepala file.
  for (const list of byStatus.values()) {
    list.sort((a, b) =>
      a.pidx !== b.pidx
        ? a.pidx - b.pidx
        : a.row.label.toLowerCase().localeCompare(b.row.label.toLowerCase()),
    )
  }

  // Section kosong TETAP dikembalikan, sama seperti nodeterm. Dua alasan: posisi tiap section
  // jadi tetap, sehingga satu sesi yang berganti status tidak menggeser seluruh daftar di bawah
  // kursor; dan "0" itu sendiri jawaban — "tidak ada yang menuntut perhatian" adalah informasi,
  // bukan ketiadaan informasi. Yang memutuskan kapan daftar nol-semua tak layak dirender adalah
  // komponen (lihat `sidebarEmptyState`), bukan fungsi ini.
  return STATUS_GROUP_ORDER.map((kind) => ({
    kind,
    label: STATUS_GROUP_LABEL[kind],
    rows: (byStatus.get(kind) ?? []).map((t) => t.row),
  }))
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

/** Kalimat mana (kalau ada) yang harus ditampilkan daftar kosong. */
export type SidebarEmptyState = 'none' | 'no-sessions' | 'no-matches'

/** "Tidak ada apa-apa di sini" dan "tidak ada yang cocok" adalah dua fakta berbeda, dan hanya
 *  yang kedua punya undo. Filter bertahan selama bekerja, jadi daftar yang kosong karena filter
 *  lama harus mengatakannya — bukan terbaca seperti sidebar yang rusak. */
export function sidebarEmptyState(noRows: boolean, filter: string): SidebarEmptyState {
  if (!noRows) return 'none'
  return filter.trim() !== '' ? 'no-matches' : 'no-sessions'
}
