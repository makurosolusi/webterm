import type { AgentId } from './workspace.agents'
import { canContextLink, type AgentPermissionMode } from './workspace.capabilities'
import type { DeviceChoice } from './browser.devices'
import type { PersistedTabs } from './browser.tabs'
import type { TabLayout } from './tabLayout.schema'
import type { AgentChatNodeConfig, AgentChatPreset } from './agentChat.shape'

// ---------------------------------------------------------------------------------------------
// Bentuk workspace yang dipersist.

export interface Viewport { x: number; y: number; zoom: number }

export interface Comment {
  id: string
  text: string
  ts: number          // epoch ms
  author?: string
}

export interface BridgeLink {
  id: string
  source: string      // node id asal link (link-out)
  target: string      // node id tujuan link (link-in / pembaca)
  /** 'context' = link antar agent yang digambar pengguna lewat handle. 'file' = penanda "file ini
   *  sedang terbuka" dari node files ke node editor-nya, dibuat otomatis (bukan lewat onConnect).
   *  Dibedakan karena labelnya beda: melabeli kabel buka-file "⇄ context" adalah label bohong. */
  /** ... 'skill' = a skill node (source, `skill-out`) attached to an agent (target, `skills-in`); see skillPorts.ts. */
  kind: 'context' | 'file' | 'skill'
}

export type WsNodeKind = 'terminal' | 'agent' | 'files' | 'editor' | 'browser' | 'diff' | 'plan' | 'app' | 'agentChat' | 'skill'

/** Satu pane = satu PTY. `id` adalah id sesi yang dipakai protokol, jadi daun akar sebuah node
 *  memakai id NODE-nya sendiri: board yang tersimpan sebelum split ada tetap menemukan shell-nya. */
export interface PaneLeaf { id: string }

/** Pembagian dua sebuah ruang. `dir: 'h'` = anak BERDAMPINGAN (`a` kiri, `b` kanan), pembatasnya
 *  tegak dan digeser di sumbu X. `dir: 'v'` = anak BERTUMPUK (`a` atas, `b` bawah). `ratio` adalah
 *  porsi untuk `a`, 0..1. Operasinya di `client/paneTree.ts`. */
export interface PaneSplit { dir: 'h' | 'v'; ratio: number; a: Pane; b: Pane }

/** Pohon pane sebuah node terminal. REKURSIF, bukan daftar datar: susunan 2×2 adalah split di
 *  dalam split, dan daftar datar tidak bisa menyatakan sisi mana yang terbagi. */
export type Pane = PaneLeaf | PaneSplit

/** A review note on a line of a Diff node file (`line` 0 = the whole file); sent to the wired agent. */
export interface DiffNoteData { id: string; path: string; line: number; body: string }

/** Caps on persisted notes: the node blob lives in one SQLite column and is saved on every edit. */
export const DIFF_NOTES_MAX = 200
export const DIFF_NOTE_BODY_MAX = 4000
const DIFF_NOTE_STR_MAX = 4096

/** The well-formed notes of an untrusted value (persisted blob, node data); malformed entries dropped. */
export function validDiffNotes(v: unknown): DiffNoteData[] {
  if (!Array.isArray(v)) return []
  const str = (x: unknown, max: number): x is string => typeof x === 'string' && x !== '' && x.length <= max
  return v.filter((n): n is DiffNoteData => !!n && typeof n === 'object'
    && str(n.id, DIFF_NOTE_STR_MAX) && str(n.path, DIFF_NOTE_STR_MAX) && str(n.body, DIFF_NOTE_BODY_MAX)
    && Number.isInteger(n.line) && n.line >= 0)
    .slice(0, DIFF_NOTES_MAX)
    .map(({ id, path, line, body }) => ({ id, path, line, body }))
}

/** One task of a Plan node draft; the server validates the brief (`dag.model.validateTasks`). */
export interface PlanTaskData { key: string; kind: 'work' | 'gate'; deps: string[]; brief: Record<string, unknown> }

/** Plan node (F4-f): an intent's DAG draft until a human approves it, then the dag it became. */
export interface PlanNodeData {
  intent: string
  workspaceId?: string
  /** Server draft job while the planner writes (in memory there; lost on restart). */
  planId?: string
  draft?: { title: string; tasks: PlanTaskData[] }
  projectId?: string
  repo?: string
  /** Set once approved: from here on the node mirrors `/api/dag/:id`. */
  dagId?: string
  /** Dispatch ids already given a worker node, so a worker the user closed is not re-added. */
  wired?: string[]
  error?: string
}

/** Cap on a persisted plan blob: the node lives in one SQLite column saved on every edit. */
export const PLAN_DATA_MAX_CHARS = 512 * 1024

/** The plan of an untrusted value (persisted blob, node data); undefined when malformed or oversized. */
export function validPlanData(v: unknown): PlanNodeData | undefined {
  if (!v || typeof v !== 'object' || typeof (v as PlanNodeData).intent !== 'string') return undefined
  if (JSON.stringify(v).length > PLAN_DATA_MAX_CHARS) return undefined
  const p = v as Record<string, unknown>
  const text = (k: string) => (typeof p[k] === 'string' ? { [k]: p[k] as string } : {})
  const d = p['draft'] as { title?: unknown; tasks?: unknown } | undefined
  const draft = d && typeof d.title === 'string' && Array.isArray(d.tasks) ? { draft: { title: d.title, tasks: d.tasks as PlanTaskData[] } } : {}
  const wired = Array.isArray(p['wired']) ? { wired: (p['wired'] as unknown[]).filter((w): w is string => typeof w === 'string') } : {}
  return { intent: p['intent'] as string, ...wired, ...text('workspaceId'), ...text('planId'), ...text('projectId'), ...text('repo'), ...text('dagId'), ...text('error'), ...draft }
}

/** Expanded folders of a Files node: relative, non-empty, no `..`/absolute segments, deduped. */
export function validExpanded(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const ok = v.filter((p): p is string =>
    typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.split('/').some((s) => s === '' || s === '.' || s === '..'))
  return [...new Set(ok)]
}

/** Opsi tampilan node 'files' yang dipersist per node (P-15). Absen = default (hidden tampil, nama naik). */
export interface ViewOpts { hidden: boolean; sortKey: 'name' | 'size' | 'mtime'; sortDir: 'asc' | 'desc' }

// CATATAN PERSISTENSI: `WsNode` dipersist sebagai satu blob JSON di satu kolom SQLite
// (`src/server/db.ts`), jadi menambah kind atau field di sini adalah NOL migration.
export interface WsNode {
  id: string
  kind: WsNodeKind
  x: number
  y: number
  width?: number          // ukuran di canvas; default diterapkan di store.toFlow
  height?: number         // ukuran di canvas; default diterapkan di store.toFlow
  /** Stable unique handle per workspace ("Mango"), assigned by `withNodeNames` (nodeNames.ts); separate from `title`. */
  name?: string
  title?: string
  cwd?: string            // jatuh ke cwd workspace bila tidak ada
  cmd?: string            // baris peluncuran agent, mis. "claude" atau override milik pengguna
  agentId?: AgentId
  color?: string
  sessionId?: string      // UUID dicetak saat peluncuran; memungkinkan resume
  claudeProfileId?: string // builtin claude node: launch profile recorded at creation (server/claudeLauncher)
  collapsed?: boolean     // chrome node diringkas jadi header saja
  hideLinks?: boolean     // edge context disembunyikan dari node ini
  comments?: Comment[]    // thread aktivitas/catatan per node
  dirPath?: string        // node 'files': direktori akar yang ditampilkan
  filePath?: string       // node 'editor': file yang dibuka
  wordWrap?: boolean      // node 'editor'/'diff': word wrap chosen by the user; absent = by file type (editorWrap.tsx)
  viewAs?: 'text'         // node 'editor': "Open as Text" on a file the viewers would show (SVG, misdetected binary); absent = by file kind
  viewOpts?: ViewOpts     // node 'files': opsi tampilan (hidden/sort); absen = default
  expanded?: string[]     // node 'files': expanded tree folders, paths relative to dirPath (validExpanded)
  panes?: Pane            // node 'terminal': pohon split pane; absen = satu terminal ber-id node
  url?: string            // node 'browser': URL terakhir (pemulihan setelah discard/restart)
  diffNotes?: DiffNoteData[] // node 'diff': review notes not yet sent (validDiffNotes)
  plan?: PlanNodeData     // node 'plan': draft / approved dag (validPlanData)
  agentControl?: boolean  // node 'browser': agent boleh mengemudikan (butuh WEBTERM_BROWSER_AGENT)
  profileId?: string      // node 'browser': browser profile (browser.profile.ts); absent = the workspace's Default profile
  device?: DeviceChoice   // node 'browser': device mode (browser.devices.ts); absent = Responsive
  zoom?: number           // node 'browser': page zoom (1 = 100%, browser.zoom.ts); absent = 100%
  tabs?: PersistedTabs    // node 'browser': tab list (urls/titles/order/cursors) restored after a restart; absent = one tab (browser.tabs.ts)
  chatSessionId?: string  // node 'agentChat': Claude session id from system/init (agentChat.shape.ts)
  permissionMode?: AgentPermissionMode // node 'agentChat': per-node mode; absent = settings default
  chatConfig?: AgentChatNodeConfig // node 'agentChat': model / effort / thinking picked in the footer (validChatConfig)
  preset?: AgentChatPreset // node 'agentChat': born as a preset (skill-author); absent = plain chat
  presetTarget?: string   // node 'agentChat': skill name a skill-author chat edits
  skill?: string          // node 'skill': name of the library skill it references (never a copy)
  seenVersion?: string    // node 'skill': active version when the node was added or last acknowledged
}

export interface Workspace {
  id: string
  name: string
  cwd?: string
  /** Identity color: a palette hue id (workspaceColor.ts); every stored workspace has one. */
  color?: string
  /** Shade of `color` (soft | default | vivid); absent = default. */
  colorShade?: string
  viewport: Viewport
  nodes: WsNode[]
  bridges: BridgeLink[]   // edge context-link antar node
  /** Tab-mode view of this workspace (tabLayout.schema.ts). Server always returns one; a PUT that omits it keeps the stored one. */
  layout?: TabLayout
  updatedAt: number
}

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 }

/** Node context-capable iff ia node agent yang harness-nya bisa membaca konteks tertaut. Menerima
 *  `undefined` (terminal biasa) sebagai false. Sadar-pewarisan lewat `canContextLink`. */
export function isContextCapable(agentId?: AgentId): boolean {
  return !!agentId && canContextLink(agentId)
}

/** Kedua ujung context-capable → link 'context' boleh terbentuk; selain itu tidak ada link. */
export function classifyLink(a?: AgentId, b?: AgentId): 'context' | null {
  return isContextCapable(a) && isContextCapable(b) ? 'context' : null
}
