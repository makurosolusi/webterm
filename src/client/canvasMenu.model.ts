// Isi menu konteks canvas sebagai DATA murni: siapa saja barisnya, dalam urutan apa, dan mana yang
// nonaktif beserta alasannya. Dipisah dari komponen render (`CanvasContextMenu.tsx`) karena vitest
// repo ini jalan di environment node TANPA DOM — memisahkan model dari React adalah satu-satunya
// cara aturan isi menu bisa diuji sama sekali. Pola ini
// `src/renderer/lib/addMenuSpec.tsx`, yang memisahkan spec item dari shell yang merendernya.
//
// PENTING soal cakupan. Menu ini SENGAJA lebih pendek dari menu canvas lengkap. Item yang
// kemampuannya belum ada di webterm — sesi remote, view browser/web/sticky/whiteboard, orkestrasi
// (spawn team, worktree), tidy/arrange layout, dan restart massal agent idle — TIDAK diikutkan:
// bukan sebagai baris redup, bukan sebagai stub `TODO`, melainkan hilang sepenuhnya. Baris yang
// tidak melakukan apa-apa mengajari pengguna hal yang salah tentang apa yang bisa aplikasi ini
// lakukan, dan itu lebih mahal daripada menu yang pendek.
import { BUILTIN_AGENT_IDS, FALLBACK_AGENT_COLOR, agentConfig, assembleCmd, customLaunchCmd } from '../shared/workspace'
import type { AgentId, BuiltinAgentId } from '../shared/workspace'
import type { CustomAgent } from '../shared/settings'

/** Ikon dirujuk lewat NAMA, bukan elemen React — supaya modul ini tetap bebas JSX dan bisa diuji. */
export type CanvasMenuIcon = 'terminal' | 'agent' | 'agentChat' | 'files' | 'browser' | 'diff' | 'select-all' | 'fit'

/** Label menu terkumpul di satu tempat, bukan bertebaran sebagai string telanjang di tiap baris. */
export const MENU_LABELS = {
  terminal: 'New Terminal',
  agentGroup: 'New Agent',
  agentChat: 'New Agent Chat',
  files: 'New File Manager',
  browser: 'New Browser',
  diff: 'Diff (working changes)',
  selectAll: 'Select All',
  fitView: 'Fit View',
} as const

/** Alasan `Select all` nonaktif. Baris yang mati tanpa alasan tidak mengajari apa pun. */
export const EMPTY_CANVAS_HINT = 'This canvas has no nodes to select yet.'

export interface CanvasMenuItem {
  /** Identitas stabil untuk key React dan untuk dicari di test — label boleh berubah, key tidak. */
  key: string
  label: string
  icon: CanvasMenuIcon
  /** Warna titik agent. Tanpa ini semua agent di submenu tampil seragam dan sulit dibedakan. */
  dot?: string
  hint?: string
  disabled?: boolean
  /** Kosong HANYA untuk baris yang punya `children`; baris biasa tanpa aksi tidak pernah dibuat. */
  onClick?: () => void
  children?: CanvasMenuItem[]
}

export type CanvasMenuRow = CanvasMenuItem | { type: 'separator' }

export const isSeparator = (r: CanvasMenuRow): r is { type: 'separator' } => 'type' in r

/**
 * Handler yang DIMILIKI pemanggil (App). Semuanya opsional kecuali yang pasti ada: sebuah baris
 * hanya lahir kalau fungsinya diberikan, jadi menu ini secara struktural tidak bisa menumbuhkan
 * item mati. Kalau integrator belum menyambung `selectAll`, barisnya tidak muncul — bukan muncul
 * lalu diam saat diklik.
 */
export interface CanvasMenuHandlers {
  addTerminal: () => void
  /** Posisi klik kanan sudah ditutup oleh pemanggil; model tidak tahu-menahu soal koordinat. */
  addAgent: (cmd: string, agentId: AgentId) => void
  addFiles: () => void
  /** Pemanggil (canvasMenu.pane) selalu memberi handler ini: saat kemampuan mati, kliknya memunculkan tawaran menyalakan. */
  addBrowser?: () => void
  /** Diff node on the workspace cwd; absent = no row. */
  addDiff?: () => void
  /** Claude chat node (no terminal); absent = Claude disabled, no row. */
  addAgentChat?: () => void
  fitView: () => void
  selectAll?: () => void
}

export interface CanvasMenuContext {
  /** Jumlah node di canvas aktif — penentu apakah `Select all` ada gunanya. */
  nodeCount: number
  /** Agent yang disembunyikan pengguna lewat settings; sama seperti yang dihormati dock. */
  disabledAgents: AgentId[]
  customAgents: CustomAgent[]
  /** Override perintah peluncuran per builtin (mis. skrip pemilih akun). */
  agentLaunchCommands: Partial<Record<BuiltinAgentId, string>>
}

/** Baris agent builtin. `assembleCmd` yang menyusun perintahnya, sama seperti jalur dock. */
function builtinItem(
  id: BuiltinAgentId,
  h: CanvasMenuHandlers,
  cmds: CanvasMenuContext['agentLaunchCommands'],
): CanvasMenuItem {
  const cfg = agentConfig(id)
  return {
    key: `agent:${id}`,
    label: `New ${cfg?.label ?? id}`,
    icon: 'agent',
    dot: cfg?.color ?? FALLBACK_AGENT_COLOR,
    // cwd dibiarkan ke pemanggil: server memakai cwd workspace, persis seperti dock yang menambah
    // agent dengan satu klik tanpa form.
    onClick: () => h.addAgent(assembleCmd(id, cmds[id]), id),
  }
}

/** Agent custom: `launchCmd` sendiri, atau perintah base bila kosong — sama seperti di dock. */
function customItem(c: CustomAgent, h: CanvasMenuHandlers, cmds: CanvasMenuContext['agentLaunchCommands']): CanvasMenuItem {
  return {
    key: `agent:${c.id}`,
    label: c.label,
    icon: 'agent',
    dot: c.color ?? FALLBACK_AGENT_COLOR,
    onClick: () => h.addAgent(customLaunchCmd(c, cmds), c.id),
  }
}

/**
 * Baris menu konteks canvas, urut atas-bawah. Murni: tidak membaca DOM, window, maupun store.
 *
 * Submenu `New agent` DIHILANGKAN (bukan dikosongkan) saat tidak ada agent yang tersisa setelah
 * filter settings — flyout kosong adalah jalan buntu yang tetap bisa dibuka.
 */
export function buildCanvasMenuRows(
  handlers: CanvasMenuHandlers,
  ctx: CanvasMenuContext,
): CanvasMenuRow[] {
  const hidden = new Set(ctx.disabledAgents)
  // Builtins (Claude Code) sit at the top level; custom agents go in the `New agent ▸` submenu.
  const promoted = BUILTIN_AGENT_IDS.filter((a) => !hidden.has(a))
  const customs = ctx.customAgents.filter((c) => !hidden.has(c.id))

  const rows: CanvasMenuRow[] = [
    { key: 'terminal', label: MENU_LABELS.terminal, icon: 'terminal', onClick: handlers.addTerminal },
    ...promoted.map((a) => builtinItem(a, handlers, ctx.agentLaunchCommands)),
  ]
  if (handlers.addAgentChat) rows.push({ key: 'agentChat', label: MENU_LABELS.agentChat, icon: 'agentChat', onClick: handlers.addAgentChat })

  const grouped = customs.map((c) => customItem(c, handlers, ctx.agentLaunchCommands))
  if (grouped.length > 0) {
    rows.push({ key: 'agent-group', label: MENU_LABELS.agentGroup, icon: 'agent', children: grouped })
  }

  // Satu-satunya jalan masuk webterm ke filesystem dari canvas; menggantikan submenu `Files ▸`
  // menu lengkap, yang isinya (open file…/new file…) butuh dialog file yang webterm belum punya.
  rows.push({ key: 'files', label: MENU_LABELS.files, icon: 'files', onClick: handlers.addFiles })
  if (handlers.addBrowser) rows.push({ key: 'browser', label: MENU_LABELS.browser, icon: 'browser', onClick: handlers.addBrowser })
  if (handlers.addDiff) rows.push({ key: 'diff', label: MENU_LABELS.diff, icon: 'diff', onClick: handlers.addDiff })

  rows.push({ type: 'separator' })

  if (handlers.selectAll) {
    const empty = ctx.nodeCount === 0
    rows.push({
      key: 'select-all',
      label: MENU_LABELS.selectAll,
      icon: 'select-all',
      disabled: empty,
      hint: empty ? EMPTY_CANVAS_HINT : undefined,
      onClick: handlers.selectAll,
    })
  }
  rows.push({ key: 'fit-view', label: MENU_LABELS.fitView, icon: 'fit', onClick: handlers.fitView })

  return rows
}
