import type { AgentId } from './workspace.agents'
import { canContextLink } from './workspace.capabilities'

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
  kind: 'context' | 'file'
}

export type WsNodeKind = 'terminal' | 'agent' | 'files' | 'editor' | 'browser'

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
  title?: string
  cwd?: string            // jatuh ke cwd workspace bila tidak ada
  cmd?: string            // baris peluncuran agent, mis. "claude" atau override milik pengguna
  agentId?: AgentId
  color?: string
  sessionId?: string      // UUID dicetak saat peluncuran; memungkinkan resume
  collapsed?: boolean     // chrome node diringkas jadi header saja
  hideLinks?: boolean     // edge context disembunyikan dari node ini
  comments?: Comment[]    // thread aktivitas/catatan per node
  dirPath?: string        // node 'files': direktori akar yang ditampilkan
  filePath?: string       // node 'editor': file yang dibuka
  viewOpts?: ViewOpts     // node 'files': opsi tampilan (hidden/sort); absen = default
  panes?: Pane            // node 'terminal': pohon split pane; absen = satu terminal ber-id node
  url?: string            // node 'browser': URL terakhir (pemulihan setelah discard/restart)
  agentControl?: boolean  // node 'browser': agent boleh mengemudikan (butuh WEBTERM_BROWSER_AGENT)
}

export interface Workspace {
  id: string
  name: string
  cwd?: string
  color?: string
  viewport: Viewport
  nodes: WsNode[]
  bridges: BridgeLink[]   // edge context-link antar node
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
