// Body of the side bar's Sessions view (the container, head and sash live in `./sideBar`): one tree
// of ALL workspaces, grouped per workspace (stacked in tab order, the open one marked Current, like
// Orca's workspace sidebar) or per status (cross-board triage). Kerangka pohonnya VS Code tree (`Tree`/`TreeItem` dari `./vscode/register`):
// tinggi baris 22px, indent 8px, hover/seleksi VS Code — semuanya dari library, bukan tiruan CSS.
// Props-driven untuk SEMUA data board (workspace, node, status): integrator yang menyuplainya.
// Two exceptions, read here directly: the `unread` marks (`./unread`) and the server facts of the
// listed ids (`useNodeStatusFactsMap`: exit, status since), which only this view needs. Each row's
// status meaning comes from the shared model (`sessionStatusView`, via `./sessionList`).
// Semua logika yang bisa dites hidup di `./sessionList` (vitest di sini tanpa DOM).
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import type { Tree, VscTreeSelectEvent } from './vscode/register'
import { VscodeMenu } from './components/vscode/vscodeMenu'
import type { RegisterTreeTarget, TreeTarget } from './SessionRow'
import { SessionsFilter } from './SessionsFilter'
import { SessionsGroupingTabs } from './SessionsGroupingTabs'
import { buildSessionMenu } from './sessionMenu'
import { SessionRenameDialog, type RenameTarget } from './sessionRename'
import { SideBarTitleActions } from './sideBar/sideBarTitleActions'
import { useNodeStatusFactsMap, useStatusNow } from './nodeStatus.store'
import { filterClosed } from './sessionList.row'
import { useSessionsTreeEvents } from './useSessionsTreeEvents'
import {
  buildSessionList,
  buildStatusList,
  projectCollapseKey,
  sessionIds,
  sidebarEmptyState,
  type SessionRowVM,
  type SidebarGrouping,
} from './sessionList'
import { CLOSED_KEY, SessionsTree } from './SessionsPanel.tree'
import type { ClosedEntry } from './closedHistory'
import { confirmReopen } from './reopenConfirm'
import { useGitBranches } from './useGitBranches'
import { useTreeItemOpenSync } from './useTreeItemOpenSync'
import { useGroupFolds } from './SessionsPanel.collapsed'
import { useUnreadIds } from './unread'
import type { AgentStatus, Workspace, WsNode } from '../shared/workspace'
import type { StatusReason } from '../shared/protocol'
import './sessions-panel.css'

export { useSessionsOpen } from './SessionsPanel.open'

type TreeElement = ComponentRef<typeof Tree>

/** Titik menu: target pohon, titik layar, dan keadaan buka grup SAAT menu dibuka. */
interface MenuState {
  target: TreeTarget
  anchor: { x: number; y: number }
  expanded: boolean
}

export interface SessionsPanelProps {
  /** True while Sessions is the visible side bar view; native tree listeners attach only then. */
  active: boolean
  /** Semua workspace, urutan tampil mengikuti urutan array ini. */
  workspaces: Workspace[]
  activeId: string | null
  /** Node canvas workspace aktif (live). `null` sebelum workspace pertama termuat. */
  liveActiveNodes: WsNode[] | null
  statuses: Record<string, AgentStatus>
  /** Why a status needs you or failed (`useStatusReasons`); absent = the fetched facts' reason. */
  reasons?: Record<string, StatusReason>
  onFocusNode: (id: string) => void
  onCloseSession: (id: string) => void
  onSelectWorkspace: (id: string) => void
  /** Sesi yang baru ditutup, terbaru dulu — sudah disaring `visibleClosed` (lihat
   *  `./closedHistory`). Kosong berarti seksinya TIDAK dirender sama sekali: header "Recently
   *  closed" tanpa isi adalah chrome mati di tiap install baru. */
  closedSessions?: ClosedEntry[]
  onReopenSession?: (nodeId: string) => void
  /** Renames a node of the OPEN board (App `onRenameNode`); rows of other boards cannot be renamed. */
  onRenameNode?: (id: string, title: string) => void
  /** Empty state's primary actions. */
  onAddTerminal?: () => void
  onAddAgent?: () => void
}

export default function SessionsPanel(props: SessionsPanelProps) {
  const { workspaces, activeId, liveActiveNodes, statuses, onFocusNode, onCloseSession, onSelectWorkspace } = props
  const { active, closedSessions = [], onReopenSession, reasons, onRenameNode, onAddTerminal, onAddAgent } = props
  const [grouping, setGrouping] = useState<SidebarGrouping>('project')
  const [filter, setFilter] = useState('')
  // Snapshot awal dibaca saat mount: kanal unread tidak memancar ulang saat disubscribe, dan
  // panel ini bisa di-mount setelah status pertama sudah lewat.
  const unread = useUnreadIds()

  const ids = useMemo(() => sessionIds(workspaces, liveActiveNodes, activeId), [workspaces, liveActiveNodes, activeId])
  const facts = useNodeStatusFactsMap(ids, active)
  const now = useStatusNow()
  const src = useMemo(() => ({ reasons, facts }), [reasons, facts])
  const groups = useMemo(
    // Every workspace, in tab order: switching board (a row click does) must not reshape the list.
    () => buildSessionList(workspaces, liveActiveNodes, activeId, statuses, filter, unread, src),
    [workspaces, liveActiveNodes, activeId, statuses, filter, unread, src],
  )
  const sections = useMemo(
    () => buildStatusList(workspaces, liveActiveNodes, activeId, statuses, filter, unread, src),
    [workspaces, liveActiveNodes, activeId, statuses, filter, unread, src],
  )
  const closed = useMemo(() => filterClosed(closedSessions, filter), [closedSessions, filter])

  const rowCount = grouping === 'status' ? sections.reduce((n, s) => n + s.rows.length, 0) : groups.reduce((n, g) => n + g.sessions.length, 0)
  // Workspaces not hydrated yet (boot): show nothing rather than "No sessions yet".
  const empty = sidebarEmptyState(rowCount === 0, filter, workspaces.length === 0 && liveActiveNodes === null)
  const branches = useGitBranches(useMemo(() => workspaces.map((w) => w.cwd), [workspaces]))
  const [renaming, setRenaming] = useState<RenameTarget | null>(null)
  const startRename = (row: Pick<SessionRowVM, 'id' | 'label' | 'title'>) => setRenaming({ id: row.id, label: row.label, title: row.title })
  // Only the open board's nodes can be renamed: App's rename writes the live canvas.
  const renameOf = (row: SessionRowVM) => (onRenameNode && row.projectId === activeId ? startRename : undefined)
  const rowById = (id: string) => groups.flatMap((g) => g.sessions).find((r) => r.id === id)

  const treeRef = useRef<TreeElement>(null)
  // Elemen pohon → aksi. Klik/Enter di dalam shadow tree tidak sampai ke root React, jadi satu
  // listener natif di `vscode-tree` membaca `vscTreeSelect` lalu memetakan item terpilih ke target.
  const targets = useRef(new WeakMap<Element, TreeTarget>())
  const register: RegisterTreeTarget = (el, target) => {
    if (el) targets.current.set(el, target)
  }

  const filterEmpty = filter.trim() === ''
  // Filtering opens everything (hidden results behind a folded row read as "no results"); see useGroupFolds.
  const { openOf, setFold, foldAll } = useGroupFolds(!filterEmpty)
  const setFoldRef = useRef(setFold)
  setFoldRef.current = setFold
  const openRef = useRef(openOf)
  openRef.current = openOf

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
      // Click/Enter on a header ONLY expands/collapses: switching here made every expand jump
      // away. Switching = inline action, menu, or a row.
      // Read NOW, outside the updater: React defers an updater to render time whenever the panel
      // already has a pending update (status tick, SSE), and by then the library has flipped
      // `open`, so a lazy `item.open` wrote the inverse and the next render undid the click.
      setFoldRef.current(target.key, item.open !== true)
      return
    }
    if (target.kind === 'reopen') {
      // A list row is easy to hit by accident; it asks first only when the reopen switches board.
      // Same board = straight through (undo exists, `closedUndo`). The inline Restore and the
      // menu's "Reopen Session" are explicit and never ask.
      const entry = closedSessions.find((e) => e.node.id === target.id)
      if (!entry || !onReopenSession) return
      if (entry.workspaceId === activeId) return onReopenSession(target.id)
      void confirmReopen(entry, activeId).then((ok) => {
        if (ok) onReopenSession(target.id)
      })
    } else onFocusNode(target.id)
  }

  useEffect(() => {
    const el = treeRef.current
    if (!el || !active) return
    const handler = (e: Event) => onSelectRef.current(e as VscTreeSelectEvent)
    el.addEventListener('vsc-tree-select', handler)
    return () => el.removeEventListener('vsc-tree-select', handler)
  }, [active])

  // Keyboard (Left/Right) and programmatic folds never emit an event: observe the DOM so React state
  // follows, otherwise the next render writes the stale value back over the user's fold.
  useTreeItemOpenSync(treeRef, (item, open) => {
    const target = targets.current.get(item)
    // Echo of our own write (or the default) = nothing to learn; only a real divergence is stored.
    if (target?.kind === 'group' && open !== openRef.current(target.key)) setFoldRef.current(target.key, open)
  }, active)

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
            onRenameSession: (id) => { const row = rowById(id); if (row) startRename(row) },
            onReopenSession,
            onSelectWorkspace,
            onToggleGroup: (key, expanded) => setFold(key, !expanded),
            onCopyText: (text) => {
              navigator.clipboard?.writeText(text).catch((err: unknown) => {
                console.warn('Copy path failed', err)
              })
            },
          })
        : [],
    // `groups` feeds `rowById` (Rename…); `startRename` only calls a state setter.
    [menu, onFocusNode, onCloseSession, onReopenSession, onSelectWorkspace, groups],
  )

  /** Kunci semua header grup yang sedang dirender pada tab aktif (untuk Collapse All). */
  const groupKeys = (): string[] =>
    grouping === 'status'
      ? sections.map((s) => `status:${s.bucket}`)
      : [...groups.map((g) => projectCollapseKey(g.projectId)), ...(closed.length > 0 ? [CLOSED_KEY] : [])]
  const collapseAll = () =>
    foldAll(groupKeys())

  return (
    <div className="sessions-view">
      <div className="sessions-view__toolbar">
        <SessionsGroupingTabs value={grouping} onChange={setGrouping} />
      </div>
      {/* VS Code: a view's own actions sit in its title row, next to Hide Side Bar. */}
      <SideBarTitleActions>
        <IconTooltip label="Collapse all groups">
          <button type="button" className="ss-action" aria-label="Collapse all" onClick={collapseAll}>
            <span className="codicon codicon-collapse-all" aria-hidden />
          </button>
        </IconTooltip>
      </SideBarTitleActions>
      <SessionsFilter value={filter} onChange={setFilter} />

      {/* nowheel: tanpa itu scroll di sini justru mem-pan canvas di belakangnya. */}
      <div className="sessions-sidebar__body nowheel" aria-busy={empty === 'loading' || undefined}>
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
            <p>No sessions yet. Start one on this board.</p>
            {onAddTerminal && (
              <button type="button" className="ss-empty__button" onClick={() => onAddTerminal()}>
                New Terminal
              </button>
            )}
            {onAddAgent && (
              <button type="button" className="ss-empty__button ss-empty__button--secondary" onClick={() => onAddAgent()}>
                New Agent
              </button>
            )}
          </div>
        )}

        <SessionsTree
          treeRef={treeRef}
          grouping={grouping}
          sections={sections}
          groups={groups}
          closedSessions={closed}
          groupOpen={openOf}
          projectOpen={openOf}
          register={register}
          now={now}
          onCloseSession={onCloseSession}
          onSelectWorkspace={onSelectWorkspace}
          renameOf={renameOf}
          onMoreActions={(target, anchor) => setMenu({ target, anchor, expanded: false })}
          onRestore={(id) => onReopenSession?.(id)}
          branches={branches}
        />
      </div>
      <VscodeMenu
        open={menu !== null}
        anchor={menu?.anchor ?? { x: 0, y: 0 }}
        items={menuItems}
        onClose={() => setMenu(null)}
        ariaLabel="Session actions"
      />
      {renaming && onRenameNode && (
        <SessionRenameDialog target={renaming} onRename={onRenameNode} onClose={() => setRenaming(null)} />
      )}
    </div>
  )
}
