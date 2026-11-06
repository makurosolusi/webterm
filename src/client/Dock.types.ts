import type { AgentId, BuiltinAgentId } from '../shared/workspace'
import type { CustomAgent } from '../shared/settings'
import type { VscodeStatusItem } from '@/components/vscode/vscodeStatusBar'

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
  /** Panel Sessions terbuka? Item `Sessions` di activity bar mengikuti keadaan ini. */
  sessionsOpen: boolean
  onToggleSessions: () => void
  /** Inbox terbuka? Item `Inbox` duduk sebaris dengan Sessions di activity bar. */
  inboxOpen: boolean
  onToggleInbox: () => void
  /** Chat TAMPIL di secondary side bar (menyalakan ikonnya)? Opsional supaya pemakaian Dock lama (dan test-nya) tetap valid:
   *  itemnya hanya dirender ketika integrator menyediakan handler. */
  chatOpen?: boolean
  onToggleChat?: () => void
  /** Panel kontrol Central tampil di secondary side bar. Item SELALU tampil; tidak ada handler = Agent Pusat mati, klik memunculkan tawaran "Nyalakan". */
  centralOpen?: boolean
  onToggleCentral?: () => void
  /** Item yang menunggu operator. 0 = tidak ada badge. Angkanya datang dari `useInboxBadge`;
   *  dock tidak pernah memanggil `fetch` sendiri. */
  inboxUnread?: number
  zoomPct: number; onZoomIn: () => void; onZoomOut: () => void
  /** Zoom ke persen absolut. Tanpa ini readout zoom cuma teks, bukan menu preset. */
  onZoomTo?: (pct: number) => void
  /** Kunci PANDANGAN (pan/zoom) sementara node tetap bisa digeser — semantik nodeterm, kebalikan
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
