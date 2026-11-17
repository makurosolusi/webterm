import type { AgentId, BuiltinAgentId } from '../shared/workspace'
import type { CustomAgent } from '../shared/settings'
import type { VscodeStatusItem } from '@/components/vscode/vscodeStatusBar'
import type { SideBarView } from './sideBar/sideBar.view'

export interface DockProps {
  onAddTerminal: () => void
  /** Tidak ada = kemampuan browser mati di server; memilih baris "Browser" memunculkan tawaran "Nyalakan". */
  onAddBrowser?: () => void
  onAddAgent: (cmd: string, agentId: AgentId, cwd?: string) => void
  onCreateWorkspace: (name: string, cwd?: string) => void
  onBrowse: (onPick: (p: string) => void) => void
  onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean
  onBack: () => void; onForward: () => void; canBack: boolean; canForward: boolean
  onFit: () => void
  onToggleBoard: () => void
  /** Kanban terbuka? Hanya untuk menandai item `Board` di activity bar. */
  boardOpen?: boolean
  /** Left side bar open, and the view it shows: that view's activity icon is lit. */
  sideBarOpen: boolean
  sideBarView: SideBarView
  /** A Layers/Sessions/Agent History icon was clicked (App applies `activityClick`). */
  onSideBarView: (view: SideBarView) => void
  /** Sessions in other workspaces needing attention: badge on the Sessions icon. 0 = no badge. */
  sessionsAttention?: number
  /** Secondary side bar terbuka, tab apa pun (menyalakan ikon Central)? Opsional supaya pemakaian Dock lama (dan test-nya) tetap valid:
   *  item Central hanya dirender ketika integrator menyediakan handler. Satu-satunya pintu ke side bar Central. */
  chatOpen?: boolean
  onToggleChat?: () => void
  /** Item yang menunggu operator (strip Needs-you), badge di ikon Central. 0 = tidak ada badge. Angkanya
   *  datang dari `useNeedsYouCount`; dock tidak pernah memanggil `fetch` sendiri. */
  needsYouCount?: number
  zoomPct: number; onZoomIn: () => void; onZoomOut: () => void
  /** Zoom ke persen absolut. Tanpa ini readout zoom cuma teks, bukan menu preset. */
  onZoomTo?: (pct: number) => void
  /** Kunci PANDANGAN (pan/zoom) sementara node tetap bisa digeser — kebalikan
   *  dari `showInteractive` bawaan React Flow yang justru mematikan drag node. Tombolnya butuh
   *  `aria-pressed`, jadi ia dirender sendiri di bawah activity bar, bukan sebagai item primitif. */
  locked: boolean
  onToggleLock: () => void
  /** Clean view menyala? Jalan keluarnya chord ⌘./Ctrl+. karena chrome ini sendiri ikut
   *  tersembunyi (lihat `cleanView.tsx`). */
  cleanView: boolean
  onToggleCleanView: () => void
  /** Nama workspace aktif untuk status bar; kosong di layar Welcome. */
  workspaceName?: string
  /** CSS color of the active workspace's identity (a `var(--ws-*)` token) for the status bar chip. */
  workspaceAccent?: string
  /** Ringkasan agent (`2 working`) — juga diumumkan lewat live region status bar. */
  agentSummary?: string
  onSave?: () => void
  onLayouts?: () => void
  onToggleMic?: () => void
  /** Dari settings; tombolnya hilang dari menu Add. Prop, bukan store — integrator yang menyambung. */
  disabledAgents?: AgentId[]
  customAgents?: CustomAgent[]
  /** Override perintah peluncuran per builtin (mis. skrip pemilih akun). Hanya builtin: agent
   *  custom sudah membawa `launchCmd`-nya sendiri. */
  agentLaunchCommands?: Partial<Record<BuiltinAgentId, string>>
  /** Membuka dialog Settings. Tombolnya (grup bawah rail, di atas Lock view) hanya ada bila handler diberikan; ia
   *  membuka dialog modal, jadi tidak pernah ditandai aktif oleh `activeActivityId`. */
  onOpenSettings?: () => void
  /** Item status bar tambahan (mis. hitungan Output); duduk di ujung kiri grup kanan. */
  extraStatusItems?: VscodeStatusItem[]
}
