// Sidebar sesi (kiri): satu pohon dari SEMUA workspace, dikelompokkan per workspace, per status,
// atau per kind node. Kerangkanya kini VS Code tree (`Tree`/`TreeItem` dari `./vscode/register`):
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
  parseCollapsed,
  projectCollapseKey,
  sidebarEmptyState,
  type SidebarGrouping,
} from './sessionList'
import { buildNodeGroups } from './nodeList'
import { CLOSED_KEY, SessionsTree } from './SessionsPanel.tree'
import type { ClosedEntry } from './closedHistory'
import { subscribeUnread, unreadIds } from './unread'
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
  /** Terkontrol: tombol pembukanya ada di Dock, jadi keadaan ini dimiliki integrator (lihat
   *  `useSessionsOpen` di `./SessionsPanel.open`). Tertutup = panel tidak merender apa pun — TIDAK ada tombol
   *  pelontar kedua di tepi kiri. */
  open: boolean
  onClose: () => void
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
  const { open, onClose, closedSessions = [], onReopenSession } = props
  const [grouping, setGrouping] = useState<SidebarGrouping>('project')
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed)
  // Snapshot awal dibaca saat mount: kanal unread tidak memancar ulang saat disubscribe, dan
  // panel ini bisa di-mount setelah status pertama sudah lewat.
  const [unread, setUnread] = useState<ReadonlySet<string>>(unreadIds)
  useEffect(() => subscribeUnread(setUnread), [])

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
    } catch {
      // Penyimpanan ditolak (mode privat): lipatan berlaku untuk sesi tab ini saja.
    }
  }, [collapsed])

  const groups = useMemo(
    () => buildSessionList(workspaces, liveActiveNodes, activeId, statuses, filter, unread),
    [workspaces, liveActiveNodes, activeId, statuses, filter, unread],
  )
  const sections = useMemo(
    () => buildStatusList(workspaces, liveActiveNodes, activeId, statuses, filter, unread),
    [workspaces, liveActiveNodes, activeId, statuses, filter, unread],
  )

  const nodeGroups = useMemo(
    () => buildNodeGroups(workspaces, liveActiveNodes, activeId, filter),
    [workspaces, liveActiveNodes, activeId, filter],
  )

  const total = sections.reduce((n, s) => n + s.rows.length, 0)
  const rowCount =
    grouping === 'nodes'
      ? nodeGroups.reduce((n, g) => n + g.rows.length, 0)
      : grouping === 'status'
        ? total
        : groups.reduce((n, g) => n + g.sessions.length, 0)
  const empty = sidebarEmptyState(rowCount === 0, filter)
  // Tab Nodes mendaftar lebih dari sesi, jadi pesan kosongnya tidak boleh bilang "sessions".
  const noun = grouping === 'nodes' ? 'nodes' : 'sessions'

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
      setCollapsed((prev) => ({ ...prev, [target.key]: item.open === true }))
      if (target.projectId && !target.isActive) onSelectWorkspace(target.projectId)
      return
    }
    if (target.kind === 'reopen') onReopenSession?.(target.id)
    else onFocusNode(target.id)
  }

  useEffect(() => {
    const el = treeRef.current
    if (!el) return
    const handler = (e: Event) => onSelectRef.current(e as VscTreeSelectEvent)
    el.addEventListener('vsc-tree-select', handler)
    return () => el.removeEventListener('vsc-tree-select', handler)
  }, [open])

  const [menu, setMenu] = useState<MenuState | null>(null)
  useSessionsTreeEvents(treeRef, {
    resolve: (el) => targets.current.get(el),
    onEndSession: onCloseSession,
    onContextMenu: (target, item, anchor) =>
      setMenu({ target, anchor, expanded: (item as HTMLElement & { open?: boolean }).open === true }),
  }, open)
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
      grouping === 'nodes'
        ? nodeGroups.map((g) => `nodes:${g.kind}`)
        : grouping === 'status'
          ? sections.map((s) => `status:${s.kind}`)
          : groups.map((g) => projectCollapseKey(g.projectId))
    return closedSessions.length > 0 && grouping !== 'nodes' ? [...keys, CLOSED_KEY] : keys
  }
  const collapseAll = () =>
    setCollapsed((prev) => ({ ...prev, ...Object.fromEntries(groupKeys().map((k) => [k, true])) }))

  // Tertutup = tidak ada apa pun di tepi kiri. Hover TIDAK pernah membuka (panel yang muncul
  // sendiri saat kursor lewat adalah yang dikeluhkan), dan satu-satunya pelontarnya ada di Dock.
  if (!open) return null

  return (
    <div className="sessions-sidebar nodrag" role="complementary" aria-label="Sessions">
      <div className="sessions-sidebar__head">
        {/* Judul DAN hitungan ikut tab aktif: tab Nodes mendaftar editor dan files juga, jadi
            "Sessions" di atasnya menamai — dan `total` menghitung — himpunan lain dari yang
            terbaca di bawahnya. `rowCount` selalu baris yang benar-benar dirender. */}
        <span className="sessions-sidebar__title">{grouping === 'nodes' ? 'Nodes' : 'Sessions'}</span>
        <span className="sessions-sidebar__count">{rowCount}</span>
        {/* Aksi view seperti toolbar judul VS Code: tampil saat view di-hover/di-fokus. */}
        <div className="sessions-sidebar__head-actions" role="toolbar" aria-label="Sessions actions">
          <IconTooltip label="Collapse all groups">
            <button
              type="button"
              className="ss-action"
              aria-label="Collapse all"
              onClick={collapseAll}
            >
              <span className="codicon codicon-collapse-all" aria-hidden />
            </button>
          </IconTooltip>
          <IconTooltip label="Hide sessions panel" commandId="view.sessions">
            <button
              type="button"
              className="ss-action"
              aria-label="Hide sessions panel"
              onClick={onClose}
            >
              <span className="codicon codicon-close" aria-hidden />
            </button>
          </IconTooltip>
        </div>
      </div>

      <SessionsGroupingTabs value={grouping} onChange={setGrouping} />
      <SessionsFilter value={filter} onChange={setFilter} />

      {/* nowheel: tanpa itu scroll di sini justru mem-pan canvas di belakangnya. */}
      <div className="sessions-sidebar__body nowheel">
        {/* Welcome view VS Code: teks deskriptif + tombol utama. */}
        {empty === 'no-matches' && (
          <div className="ss-empty">
            <p>
              No {noun} match “{filter.trim()}”.
            </p>
            <button type="button" className="ss-empty__button" onClick={() => setFilter('')}>
              Clear Filter
            </button>
          </div>
        )}
        {empty === 'no-sessions' && (
          <div className="ss-empty">
            <p>No {noun} yet.</p>
          </div>
        )}

        <SessionsTree
          treeRef={treeRef}
          grouping={grouping}
          nodeGroups={nodeGroups}
          sections={sections}
          groups={groups}
          closedSessions={closedSessions}
          empty={empty}
          groupOpen={groupOpen}
          projectOpen={projectOpen}
          register={register}
          onCloseSession={onCloseSession}
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
