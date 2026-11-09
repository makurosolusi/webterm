// Body of the side bar's Sessions view (the container, head and sash live in `./sideBar`): one tree
// of the OTHER workspaces, grouped per workspace or per status (Status stays cross-board for
// triage). Kerangka pohonnya VS Code tree (`Tree`/`TreeItem` dari `./vscode/register`):
// tinggi baris 22px, indent 8px, hover/seleksi VS Code — semuanya dari library, bukan tiruan CSS.
// Props-driven untuk SEMUA data board (workspace, node, status): integrator yang menyuplainya.
// SATU pengecualian, dan alasannya: tanda `unread` disubscribe langsung dari `./unread` di sini.
// Ia state turunan-transport dengan tepat satu pembaca — section "Unread" di panel ini — jadi
// mengalirkannya lewat prop dari `App` berarti menambah parameter yang tak ada pembaca keduanya.
// Semua logika yang bisa dites hidup di `./sessionList` (vitest di sini tanpa DOM).
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import type { Tree, VscTreeSelectEvent } from './vscode/register'
import { VscodeMenu } from './components/vscode/vscodeMenu'
import type { RegisterTreeTarget, TreeTarget } from './SessionRow'
import { SessionsFilter } from './SessionsFilter'
import { SessionsGroupingTabs } from './SessionsGroupingTabs'
import { buildSessionMenu } from './sessionMenu'
import { useSessionsTreeEvents } from './useSessionsTreeEvents'
import {
  buildSessionList,
  buildStatusList,
  isProjectCollapsed,
  otherWorkspaceGroups,
  parseCollapsed,
  projectCollapseKey,
  sidebarEmptyState,
  type SidebarGrouping,
} from './sessionList'
import { CLOSED_KEY, SessionsTree } from './SessionsPanel.tree'
import type { ClosedEntry } from './closedHistory'
import { useUnreadIds } from './unread'
import type { AgentStatus, Workspace, WsNode } from '../shared/workspace'
import './sessions-panel.css'

export { useSessionsOpen } from './SessionsPanel.open'

type TreeElement = ComponentRef<typeof Tree>

/** Titik menu: target pohon, titik layar, dan keadaan buka grup SAAT menu dibuka. */
interface MenuState {
  target: TreeTarget
  anchor: { x: number; y: number }
  expanded: boolean
}

/** Peta lipatan (JSON `{ kunci: terlipat }`). Dipersist karena membuka ulang board tiap reload
 *  adalah kerja yang pengguna sudah lakukan sekali. */
const COLLAPSED_KEY = 'webterm.sessionsCollapsed'

export interface SessionsPanelProps {
  /** True while Sessions is the visible side bar view; native tree listeners attach only then. */
  active: boolean
  /** Semua workspace, urutan tampil mengikuti urutan array ini. */
  workspaces: Workspace[]
  activeId: string | null
  /** Node canvas workspace aktif (live). `null` sebelum workspace pertama termuat. */
  liveActiveNodes: WsNode[] | null
  statuses: Record<string, AgentStatus>
  onFocusNode: (id: string) => void
  onCloseSession: (id: string) => void
  onSelectWorkspace: (id: string) => void
  /** Sesi yang baru ditutup, terbaru dulu — sudah disaring `visibleClosed` (lihat
   *  `./closedHistory`). Kosong berarti seksinya TIDAK dirender sama sekali: header "Recently
   *  closed" tanpa isi adalah chrome mati di tiap install baru. */
  closedSessions?: ClosedEntry[]
  onReopenSession?: (nodeId: string) => void
}

function readCollapsed(): Record<string, boolean> {
  // Sama seperti `readOpen`: akses localStorage sendiri bisa melempar (mode privat / site data
  // diblokir), dan panel harus tetap jalan tanpa penyimpanan.
  try {
    return parseCollapsed(localStorage.getItem(COLLAPSED_KEY))
  } catch {
    return {}
  }
}

export default function SessionsPanel(props: SessionsPanelProps) {
  const { workspaces, activeId, liveActiveNodes, statuses, onFocusNode, onCloseSession, onSelectWorkspace } = props
  const { active, closedSessions = [], onReopenSession } = props
  const [grouping, setGrouping] = useState<SidebarGrouping>('project')
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed)
  // Snapshot awal dibaca saat mount: kanal unread tidak memancar ulang saat disubscribe, dan
  // panel ini bisa di-mount setelah status pertama sudah lewat.
  const unread = useUnreadIds()

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
    } catch {
      // Penyimpanan ditolak (mode privat): lipatan berlaku untuk sesi tab ini saja.
    }
  }, [collapsed])

  const groups = useMemo(
    () => otherWorkspaceGroups(buildSessionList(workspaces, liveActiveNodes, activeId, statuses, filter, unread)),
    [workspaces, liveActiveNodes, activeId, statuses, filter, unread],
  )
  const sections = useMemo(
    () => buildStatusList(workspaces, liveActiveNodes, activeId, statuses, filter, unread),
    [workspaces, liveActiveNodes, activeId, statuses, filter, unread],
  )

  const total = sections.reduce((n, s) => n + s.rows.length, 0)
  const rowCount = grouping === 'status' ? total : groups.reduce((n, g) => n + g.sessions.length, 0)
  const onlyActive = grouping === 'project' && workspaces.length > 0 && workspaces.every((w) => w.id === activeId)
  const empty = sidebarEmptyState(rowCount === 0, filter, onlyActive)

  const treeRef = useRef<TreeElement>(null)
  // Elemen pohon → aksi. Klik/Enter di dalam shadow tree tidak sampai ke root React, jadi satu
  // listener natif di `vscode-tree` membaca `vscTreeSelect` lalu memetakan item terpilih ke target.
  const targets = useRef(new WeakMap<Element, TreeTarget>())
  const register: RegisterTreeTarget = (el, target) => {
    if (el) targets.current.set(el, target)
  }

  const filterEmpty = filter.trim() === ''
  // Selagi memfilter semuanya dibuka: hasil yang disembunyikan di balik baris terlipat terbaca
  // seperti "tidak ada hasil".
  const groupOpen = (key: string) => !filterEmpty || !(collapsed[key] ?? false)
  const projectOpen = (key: string) => !filterEmpty || !isProjectCollapsed(collapsed, key)

  const onSelectRef = useRef<(event: VscTreeSelectEvent) => void>(() => {})
  onSelectRef.current = (event) => {
    // Runtime library memancarkan `detail` sebagai ARRAY item, walau `.d.ts`-nya menulis
    // `{ selectedItems }`. Keduanya diterima supaya versi berikutnya tidak diam-diam mematikan
    // seluruh panel: klik yang tidak sampai ke handler = baris yang tak bisa difokuskan.
    const detail = event.detail as unknown
    const items = Array.isArray(detail)
      ? detail
      : ((detail as { selectedItems?: unknown[] } | undefined)?.selectedItems ?? [])
    const item = items[0] as (Element & { open?: boolean }) | undefined
    const target = item ? targets.current.get(item) : undefined
    if (!target || !item) return
    if (target.kind === 'group') {
      // Library membalik `open` SETELAH event ini, jadi nilai `open` di sini adalah keadaan
      // SEBELUM klik. Peta lipatan menyimpan "terlipat", yang persis sama dengan nilai itu.
      // Click/Enter on a header ONLY expands/collapses: Project view lists other boards only, so
      // switching here made every expand jump away. Switching = inline action, menu, or a row.
      setCollapsed((prev) => ({ ...prev, [target.key]: item.open === true }))
      return
    }
    if (target.kind === 'reopen') onReopenSession?.(target.id)
    else onFocusNode(target.id)
  }

  useEffect(() => {
    const el = treeRef.current
    if (!el || !active) return
    const handler = (e: Event) => onSelectRef.current(e as VscTreeSelectEvent)
    el.addEventListener('vsc-tree-select', handler)
    return () => el.removeEventListener('vsc-tree-select', handler)
  }, [active])

  const [menu, setMenu] = useState<MenuState | null>(null)
  useSessionsTreeEvents(treeRef, {
    resolve: (el) => targets.current.get(el),
    onEndSession: onCloseSession,
    onContextMenu: (target, item, anchor) =>
      setMenu({ target, anchor, expanded: (item as HTMLElement & { open?: boolean }).open === true }),
  }, active)
  const menuItems = useMemo(
    () =>
      menu
        ? buildSessionMenu(menu.target, menu.expanded, {
            onFocusNode,
            onCloseSession,
            onReopenSession,
            onSelectWorkspace,
            onToggleGroup: (key, expanded) => setCollapsed((prev) => ({ ...prev, [key]: expanded })),
            onCopyText: (text) => {
              navigator.clipboard?.writeText(text).catch((err: unknown) => {
                console.warn('Copy path failed', err)
              })
            },
          })
        : [],
    [menu, onFocusNode, onCloseSession, onReopenSession, onSelectWorkspace],
  )

  /** Kunci semua header grup yang sedang dirender pada tab aktif (untuk Collapse All). */
  const groupKeys = (): string[] => {
    const keys =
      grouping === 'status'
        ? sections.map((s) => `status:${s.kind}`)
        : groups.map((g) => projectCollapseKey(g.projectId))
    return closedSessions.length > 0 ? [...keys, CLOSED_KEY] : keys
  }
  const collapseAll = () =>
    setCollapsed((prev) => ({ ...prev, ...Object.fromEntries(groupKeys().map((k) => [k, true])) }))

  return (
    <div className="sessions-view">
      <div className="sessions-view__toolbar">
        <SessionsGroupingTabs value={grouping} onChange={setGrouping} />
        <IconTooltip label="Collapse all groups">
          <button type="button" className="ss-action" aria-label="Collapse all" onClick={collapseAll}>
            <span className="codicon codicon-collapse-all" aria-hidden />
          </button>
        </IconTooltip>
      </div>
      <SessionsFilter value={filter} onChange={setFilter} />

      {/* nowheel: tanpa itu scroll di sini justru mem-pan canvas di belakangnya. */}
      <div className="sessions-sidebar__body nowheel">
        {/* Welcome view VS Code: teks deskriptif + tombol utama. */}
        {empty === 'no-matches' && (
          <div className="ss-empty">
            <p>No sessions match “{filter.trim()}”.</p>
            <button type="button" className="ss-empty__button" onClick={() => setFilter('')}>
              Clear Filter
            </button>
          </div>
        )}
        {empty === 'no-sessions' && (
          <div className="ss-empty">
            <p>No sessions yet.</p>
          </div>
        )}
        {empty === 'only-active' && (
          <div className="ss-empty">
            <p>Other workspaces' sessions appear here.</p>
          </div>
        )}

        <SessionsTree
          treeRef={treeRef}
          grouping={grouping}
          sections={sections}
          groups={groups}
          closedSessions={closedSessions}
          empty={empty}
          groupOpen={groupOpen}
          projectOpen={projectOpen}
          register={register}
          onCloseSession={onCloseSession}
          onSelectWorkspace={onSelectWorkspace}
        />
      </div>
      <VscodeMenu
        open={menu !== null}
        anchor={menu?.anchor ?? { x: 0, y: 0 }}
        items={menuItems}
        onClose={() => setMenu(null)}
        ariaLabel="Session actions"
      />
    </div>
  )
}
