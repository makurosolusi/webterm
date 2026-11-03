// Sidebar sesi (kiri): satu pohon dari SEMUA workspace, dikelompokkan per workspace, per status,
// atau per kind node. Kerangkanya kini VS Code tree (`Tree`/`TreeItem` dari `./vscode/register`):
// tinggi baris 22px, indent 8px, hover/seleksi VS Code — semuanya dari library, bukan tiruan CSS.
// Props-driven untuk SEMUA data board (workspace, node, status): integrator yang menyuplainya.
// SATU pengecualian, dan alasannya: tanda `unread` disubscribe langsung dari `./unread` di sini.
// Ia state turunan-transport dengan tepat satu pembaca — section "Unread" di panel ini — jadi
// mengalirkannya lewat prop dari `App` berarti menambah parameter yang tak ada pembaca keduanya.
// Semua logika yang bisa dites hidup di `./sessionList` (vitest di sini tanpa DOM).
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import { Tree, TreeItem } from './vscode/register'
import type { VscTreeSelectEvent } from './vscode/register'
import { VscodeMenu } from './components/vscode/vscodeMenu'
import { SessionGroupItem, SessionTreeItem, type RegisterTreeTarget, type TreeTarget } from './SessionRow'
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
  sessionLabel,
  signalCounts,
  type SidebarGrouping,
} from './sessionList'
import { buildNodeGroups } from './nodeList'
import type { ClosedEntry } from './closedHistory'
import { subscribeUnread, unreadIds } from './unread'
import type { AgentStatus, Workspace, WsNode, WsNodeKind } from '../shared/workspace'
import './sessions-panel.css'

type TreeElement = ComponentRef<typeof Tree>

/** Codicon per kind untuk branch tab Nodes. Baris di sana tidak punya status, jadi slot ikonnya
 *  kosong — dan bentuk adalah satu-satunya pembeda yang terbaca tanpa membaca: judul kustom
 *  ("notes", "scratch") sama-sama mungkin milik editor, terminal, atau folder. */
const KIND_ICON: Record<WsNodeKind, string> = {
  agent: 'hubot',
  terminal: 'terminal',
  editor: 'file',
  files: 'folder',
  browser: 'globe',
}

/** Glyph kind (codicon) untuk header grup dan baris tab Nodes. */
function KindIcon({ kind }: { kind: WsNodeKind }) {
  return <span className={`codicon codicon-${KIND_ICON[kind]}`} aria-hidden />
}

/** Titik menu: target pohon, titik layar, dan keadaan buka grup SAAT menu dibuka. */
interface MenuState {
  target: TreeTarget
  anchor: { x: number; y: number }
  expanded: boolean
}

/** Kunci persist keadaan terbuka/tertutup. Namanya warisan dari masa panel ini punya hover-peek
 *  (dulu "pinned" vs "peek"); JANGAN diganti — nilainya sudah tersimpan di browser pengguna. */
const PIN_KEY = 'webterm.sessionsPinned'
/** Peta lipatan (JSON `{ kunci: terlipat }`). Dipersist karena membuka ulang board tiap reload
 *  adalah kerja yang pengguna sudah lakukan sekali. */
const COLLAPSED_KEY = 'webterm.sessionsCollapsed'
/** Kunci disclosure seksi "Recently closed", berbagi `collapsed` dengan baris workspace. Tidak bisa
 *  bertabrakan: kunci workspace selalu berawalan `project:` (lihat `projectCollapseKey`). */
const CLOSED_KEY = 'closed'

export interface SessionsPanelProps {
  /** Terkontrol: tombol pembukanya ada di Dock, jadi keadaan ini dimiliki integrator (lihat
   *  `useSessionsOpen` di bawah). Tertutup = panel tidak merender apa pun — TIDAK ada tombol
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

function readOpen(): boolean {
  // Mode privat / site data diblokir membuat sentuhan ke localStorage sendiri melempar;
  // default-nya tersemat (panel terbuka), jadi sidebar tetap jalan tanpa penyimpanan.
  try {
    return localStorage.getItem(PIN_KEY) !== '0'
  } catch {
    return true
  }
}

/**
 * Keadaan buka/tutup panel + persistensinya, dipakai integrator (`App`). Hidup DI LUAR panel karena
 * tombol pembukanya ada di Dock: dua permukaan membaca satu keadaan, dan state di dalam panel
 * membuat panel yang tertutup jadi satu-satunya yang tahu ia tertutup.
 */
export function useSessionsOpen() {
  const [open, setOpen] = useState(readOpen)
  useEffect(() => {
    try {
      localStorage.setItem(PIN_KEY, open ? '1' : '0')
    } catch {
      // Penyimpanan ditolak (mode privat): pilihan buka/tutup berlaku untuk sesi tab ini saja.
    }
  }, [open])
  return [open, setOpen] as const
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

function monogram(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
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
          <button
            type="button"
            className="ss-action"
            aria-label="Collapse all"
            title="Collapse All"
            onClick={collapseAll}
          >
            <span className="codicon codicon-collapse-all" aria-hidden />
          </button>
          <button
            type="button"
            className="ss-action"
            aria-label="Hide sessions panel"
            title="Hide"
            onClick={onClose}
          >
            <span className="codicon codicon-close" aria-hidden />
          </button>
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

        <Tree
          ref={treeRef}
          className="ss-tree"
          indent={8}
          aria-label={`${grouping === 'nodes' ? 'Nodes' : 'Sessions'} tree`}
        >
          {/* Satu-satunya daftar yang memuat node files/editor juga — jadi satu-satunya jalan
              memusatkan canvas ke node yang bukan shell. */}
          {grouping === 'nodes' ? (
            nodeGroups.map((g) => {
              return (
                <SessionGroupItem
                  key={g.kind}
                  groupKey={`nodes:${g.kind}`}
                  label={g.label}
                  count={g.rows.length}
                  open={groupOpen(`nodes:${g.kind}`)}
                  register={register}
                  icon={<KindIcon kind={g.kind} />}
                >
                  {g.rows.map((r) => (
                    <TreeItem
                      key={r.id}
                      className="ss-tree__leaf"
                      aria-label={`Focus ${r.label}`}
                      title={r.detail ?? ''}
                      ref={(el) => register(el, { kind: 'node', id: r.id, path: r.detail })}
                    >
                      <span slot="icon-leaf" className="ss-tree__kind" aria-hidden>
                        <KindIcon kind={g.kind} />
                      </span>
                      {/* Tanpa meta: satu board saja (nama workspace sama di tiap baris), dan
                          kind sudah disebut header seksi + ikon. */}
                      <span className="ss-tree__label">{r.label}</span>
                    </TreeItem>
                  ))}
                </SessionGroupItem>
              )
            })
          ) : grouping === 'status' ? (
            // `buildStatusList` menahan SEMUA section supaya posisinya tetap; yang memutuskan mana
            // yang layak dirender adalah di sini. Section kosong disembunyikan — header "0" tidak
            // membawa apa pun dan tiga di antaranya memakan separuh panel. Satu pengecualian:
            // `attention`, karena nol di sana adalah kabar baik yang justru dicari pengguna, jadi
            // ketiadaannya tidak boleh dibaca sebagai "belum dihitung".
            empty === 'none' &&
            sections.filter((s) => s.kind === 'attention' || s.rows.length > 0).map((s) => (
              <SessionGroupItem
                key={s.kind}
                groupKey={`status:${s.kind}`}
                label={s.label}
                count={s.rows.length}
                open={groupOpen(`status:${s.kind}`)}
                register={register}
                icon={
                  <span
                    className={`codicon codicon-${s.kind === 'attention' ? 'bell' : 'circle-filled'} ss-status__icon ss-status__icon--${s.kind}`}
                    aria-hidden
                  />
                }
              >
                {s.rows.length > 0 && (
                  s.rows.map((r) => (
                    <SessionTreeItem
                      key={r.id}
                      row={r}
                      showProject
                      onCloseSession={onCloseSession}
                      register={register}
                    />
                  ))
                )}
              </SessionGroupItem>
            ))
          ) : (
            groups.map((g) => {
              const key = projectCollapseKey(g.projectId)
              const isCollapsed = !projectOpen(key)
              const sig = signalCounts(g.sessions)
              return (
                <SessionGroupItem
                  key={g.projectId}
                  groupKey={key}
                  label={g.projectName}
                  count={g.sessions.length}
                  open={!isCollapsed}
                  register={register}
                  // Klik header berpindah board kalau board itu belum aktif; klik pada board yang
                  // aktif hanya melipat/membukanya. Chevron tetap melipat board mana pun.
                  workspace
                  projectId={g.projectId}
                  isActive={g.isActive}
                  monogram={monogram(g.projectName)}
                  color={g.projectColor}
                  signals={sig}
                >
                  {g.sessions.map((r) => (
                    <SessionTreeItem
                      key={r.id}
                      row={r}
                      showProject={false}
                      onCloseSession={onCloseSession}
                      register={register}
                    />
                  ))}
                </SessionGroupItem>
              )
            })
          )}

          {/* Dirender HANYA bila ada isinya — dan di luar gerbang `empty`: board yang seluruh
              sesinya baru saja ditutup adalah justru saat daftar ini paling berguna. */}
          {grouping !== 'nodes' && closedSessions.length > 0 && (
            <SessionGroupItem
              groupKey={CLOSED_KEY}
              label="Recently closed"
              count={closedSessions.length}
              open={groupOpen(CLOSED_KEY)}
              register={register}
            >
              {closedSessions.map((e) => (
                <TreeItem
                  key={e.node.id}
                  className="ss-tree__leaf"
                  aria-label={`Reopen ${sessionLabel(e.node)}`}
                  title={e.node.cwd ?? ''}
                  ref={(el) => register(el, { kind: 'reopen', id: e.node.id, path: e.node.cwd })}
                >
                  <span className="ss-tree__label">{sessionLabel(e.node)}</span>
                  {/* Nama workspace SELALU ikut: daftar ini meruntuhkan dinding workspace
                      seperti mode status, jadi tanpa itu barisnya tidak bilang akan muncul
                      kembali di board mana. */}
                  <span slot="description" className="ss-meta">
                    {e.workspaceName}
                  </span>
                </TreeItem>
              ))}
            </SessionGroupItem>
          )}
        </Tree>
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
