// Sidebar sesi (kiri): satu daftar dari SEMUA workspace, dikelompokkan per workspace atau per
// status. Dibentuk mengikuti nodeterm v0.4.5 `SessionsSidebar.tsx` + `SessionRow.tsx`.
// Props-driven untuk SEMUA data board (workspace, node, status): integrator yang menyuplainya.
// SATU pengecualian, dan alasannya: tanda `unread` disubscribe langsung dari `./unread` di sini.
// Ia state turunan-transport dengan tepat satu pembaca — section "Unread" di panel ini — jadi
// mengalirkannya lewat prop dari `App` berarti menambah parameter yang tak ada pembaca keduanya.
// Semua logika yang bisa dites hidup di `./sessionList` (vitest di sini tanpa DOM).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bell, Bot, ChevronDown, ChevronRight, FileText, Folder, PanelLeft, Pin, PinOff, Terminal, X } from 'lucide-react'
import SessionRow from './SessionRow'
import {
  buildSessionList,
  buildStatusList,
  isProjectCollapsed,
  parseCollapsed,
  projectCollapseKey,
  projectHeadClickAction,
  sidebarEmptyState,
  sessionLabel,
  sidebarFilterKeyAction,
  signalCounts,
  type SidebarGrouping,
} from './sessionList'
import { buildNodeGroups } from './nodeList'
import type { ClosedEntry } from './closedHistory'
import { subscribeUnread, unreadIds } from './unread'
import type { AgentStatus, Workspace, WsNode, WsNodeKind } from '../shared/workspace'
import './sessions-panel.css'

const TAB_LABEL: Record<SidebarGrouping, string> = {
  project: 'Project',
  status: 'Status',
  nodes: 'Nodes',
}

/** Ikon per kind untuk baris tab Nodes. Baris di sana tidak punya status, jadi slot glyph-nya
 *  kosong — dan bentuk adalah satu-satunya pembeda yang terbaca tanpa membaca: judul kustom
 *  ("notes", "scratch") sama-sama mungkin milik editor, terminal, atau folder. */
const KIND_ICON: Record<WsNodeKind, typeof Bot> = {
  agent: Bot,
  terminal: Terminal,
  editor: FileText,
  files: Folder,
}

const PIN_KEY = 'webterm.sessionsPinned'
/** Peta lipatan (JSON `{ kunci: terlipat }`). Dipersist karena membuka ulang board tiap reload
 *  adalah kerja yang pengguna sudah lakukan sekali. */
const COLLAPSED_KEY = 'webterm.sessionsCollapsed'
/** Jeda tutup hover-peek. Tanpa jeda, gerak diagonal dari ikon ke panel melewati celah dan
 *  panel tertutup di tengah jalan. Sama dengan nodeterm. */
const PEEK_CLOSE_MS = 140
/** Kunci disclosure seksi "Recently closed", berbagi `collapsed` dengan baris workspace. Tidak bisa
 *  bertabrakan: kunci workspace selalu berawalan `project:` (lihat `projectCollapseKey`). */
const CLOSED_KEY = 'closed'

export interface SessionsPanelProps {
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

function readPinned(): boolean {
  // Mode privat / site data diblokir membuat sentuhan ke localStorage sendiri melempar;
  // default-nya tersemat (panel terbuka), jadi sidebar tetap jalan tanpa penyimpanan.
  try {
    return localStorage.getItem(PIN_KEY) !== '0'
  } catch {
    return true
  }
}

function readCollapsed(): Record<string, boolean> {
  // Sama seperti `readPinned`: akses localStorage sendiri bisa melempar (mode privat / site data
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
  const { closedSessions = [], onReopenSession } = props
  const [pinned, setPinned] = useState(readPinned)
  const [peek, setPeek] = useState(false)
  const [grouping, setGrouping] = useState<SidebarGrouping>('project')
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Snapshot awal dibaca saat mount: kanal unread tidak memancar ulang saat disubscribe, dan
  // panel ini bisa di-mount setelah status pertama sudah lewat.
  const [unread, setUnread] = useState<ReadonlySet<string>>(unreadIds)
  useEffect(() => subscribeUnread(setUnread), [])

  useEffect(() => {
    try {
      localStorage.setItem(PIN_KEY, pinned ? '1' : '0')
    } catch {
      // Penyimpanan ditolak (mode privat): pilihan pin berlaku untuk sesi tab ini saja.
    }
  }, [pinned])

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
    } catch {
      // Penyimpanan ditolak (mode privat): lipatan berlaku untuk sesi tab ini saja.
    }
  }, [collapsed])

  useEffect(() => () => void (closeTimer.current && clearTimeout(closeTimer.current)), [])

  const openPeek = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setPeek(true)
  }, [])

  const closePeekSoon = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setPeek(false), PEEK_CLOSE_MS)
  }, [])

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
  const attention = sections.find((s) => s.kind === 'attention')?.rows.length ?? 0
  const rowCount =
    grouping === 'nodes'
      ? nodeGroups.reduce((n, g) => n + g.rows.length, 0)
      : grouping === 'status'
        ? total
        : groups.reduce((n, g) => n + g.sessions.length, 0)
  const empty = sidebarEmptyState(rowCount === 0, filter)
  // Tab Nodes mendaftar lebih dari sesi, jadi pesan kosongnya tidak boleh bilang "sessions".
  const noun = grouping === 'nodes' ? 'nodes' : 'sessions'

  if (!pinned && !peek) {
    return (
      <div className="sessions-icon-cluster nodrag" onMouseEnter={openPeek} onMouseLeave={closePeekSoon}>
        <button type="button" aria-label="Show sessions" title="Sessions" onClick={() => setPinned(true)}>
          <PanelLeft aria-hidden />
          {attention > 0 && <span className="ss-cluster__badge">{attention}</span>}
        </button>
      </div>
    )
  }

  const toggle = (key: string, cur: boolean) => setCollapsed((prev) => ({ ...prev, [key]: !cur }))
  // Default TERBUKA, beda dari baris workspace: seksi ini cuma muncul kalau ada isinya, jadi
  // menyembunyikan isi itu di balik satu klik lagi akan menghapus satu-satunya alasan ia muncul.
  const closedCollapsed = collapsed[CLOSED_KEY] ?? false

  return (
    <aside
      className="sessions-sidebar nodrag"
      aria-label="Sessions"
      onMouseEnter={openPeek}
      onMouseLeave={pinned ? undefined : closePeekSoon}
    >
      <div className="sessions-sidebar__head">
        {/* Judul DAN hitungan ikut tab aktif: tab Nodes mendaftar editor dan files juga, jadi
            "Sessions" di atasnya menamai — dan `total` menghitung — himpunan lain dari yang
            terbaca di bawahnya. `rowCount` selalu baris yang benar-benar dirender. */}
        <span className="sessions-sidebar__title">{grouping === 'nodes' ? 'Nodes' : 'Sessions'}</span>
        <span className="sessions-sidebar__count">{rowCount}</span>
        <div className="sessions-sidebar__head-actions">
          <button
            type="button"
            className="ss-iconbtn"
            aria-pressed={pinned}
            aria-label={pinned ? 'Unpin sessions panel' : 'Pin sessions panel'}
            title={pinned ? 'Unpin (peek on hover)' : 'Pin open'}
            onClick={() => setPinned((v) => !v)}
          >
            {pinned ? <Pin aria-hidden /> : <PinOff aria-hidden />}
          </button>
          <button
            type="button"
            className="ss-iconbtn"
            aria-label="Hide sessions panel"
            title="Hide"
            onClick={() => {
              setPinned(false)
              setPeek(false)
            }}
          >
            <X aria-hidden />
          </button>
        </div>
      </div>

      <div className="ss-tabs" role="tablist" aria-label="Group sessions by">
        {(['project', 'status', 'nodes'] as const).map((g) => (
          <button
            key={g}
            type="button"
            role="tab"
            className="ss-tab"
            aria-selected={grouping === g}
            onClick={() => setGrouping(g)}
          >
            {TAB_LABEL[g]}
          </button>
        ))}
      </div>

      <div className="sessions-sidebar__search">
        <input
          value={filter}
          placeholder="Filter sessions…"
          aria-label="Filter sessions"
          onChange={(e) => setFilter(e.target.value)}
          // Canvas React Flow mendengarkan keyboard di document: tanpa stopPropagation,
          // Backspace menghapus node terpilih dan panah menggeser canvas selagi mengetik.
          onKeyDown={(e) => {
            e.stopPropagation()
            if (sidebarFilterKeyAction(e.key, filter) === 'clear') setFilter('')
          }}
        />
        {filter !== '' && (
          <button
            type="button"
            className="ss-iconbtn ss-search__clear"
            aria-label="Clear filter"
            title="Clear filter (Esc)"
            onClick={() => setFilter('')}
          >
            <X aria-hidden />
          </button>
        )}
      </div>

      {/* nowheel: tanpa itu scroll di sini justru mem-pan canvas di belakangnya. */}
      <div className="sessions-sidebar__body nowheel">
        {empty === 'no-matches' && (
          <div className="ss-empty">
            <div>
              No {noun} match “{filter.trim()}”.
            </div>
            <button type="button" onClick={() => setFilter('')}>
              Clear filter
            </button>
          </div>
        )}
        {empty === 'no-sessions' && <div className="ss-empty">No {noun} yet.</div>}

        {/* Satu-satunya daftar yang memuat node files/editor juga — jadi satu-satunya jalan
            memusatkan canvas ke node yang bukan shell. Baris memakai ulang `.ss-row` apa adanya
            (nol CSS baru); fokus, zoom, dan pindah workspace sudah milik `onFocusNode`. */}
        {grouping === 'nodes' ? (
          nodeGroups.map((g) => {
            const Icon = KIND_ICON[g.kind]
            return (
              <section key={g.kind} className="ss-status" aria-label={g.label}>
                <div className="ss-status__head">
                  <span className="ss-status__label">{g.label}</span>
                  <span className="ss-status__count">{g.rows.length}</span>
                </div>
                <ul className="ss-rows ss-status__rows">
                  {g.rows.map((r) => (
                    <li key={r.id}>
                      <div
                        className="ss-row"
                        role="button"
                        tabIndex={0}
                        title={r.detail ?? ''}
                        aria-label={`Focus ${r.label}`}
                        onClick={() => onFocusNode(r.id)}
                        onKeyDown={(ev) => {
                          if (ev.key !== 'Enter' && ev.key !== ' ') return
                          ev.preventDefault()
                          ev.stopPropagation()
                          onFocusNode(r.id)
                        }}
                      >
                        <span className="ss-row__glyph">
                          <Icon aria-hidden />
                        </span>
                        {/* Tanpa meta: satu board saja (nama workspace sama di tiap baris), dan
                            kind sudah disebut header seksi + ikon — kadang judulnya sendiri. */}
                        <span className="ss-row__text">
                          <span className="ss-row__title">{r.label}</span>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })
        ) : grouping === 'status'
          ? // `buildStatusList` menahan SEMUA section supaya posisinya tetap; yang memutuskan mana
            // yang layak dirender adalah di sini. Section kosong disembunyikan — header "0" tidak
            // membawa apa pun dan tiga di antaranya memakan separuh panel. Satu pengecualian:
            // `attention`, karena nol di sana adalah kabar baik yang justru dicari pengguna, jadi
            // ketiadaannya tidak boleh dibaca sebagai "belum dihitung".
            empty === 'none' &&
            sections.filter((s) => s.kind === 'attention' || s.rows.length > 0).map((s) => (
              <section key={s.kind} className="ss-status" aria-label={s.label}>
                <div className="ss-status__head">
                  {/* Bel untuk attention, titik berwarna untuk sisanya — glyph yang sama dengan
                      barisnya, supaya header dan isi bicara dalam satu bahasa. */}
                  {s.kind === 'attention' ? (
                    <span className="ss-status__icon ss-status__icon--attention">
                      <Bell aria-hidden />
                    </span>
                  ) : (
                    <span className={`ss-status__icon ss-status__icon--${s.kind}`} aria-hidden />
                  )}
                  <span className="ss-status__label">{s.label}</span>
                  <span className="ss-status__count">{s.rows.length}</span>
                </div>
                {s.rows.length > 0 && (
                  <ul className="ss-rows ss-status__rows">
                    {s.rows.map((r) => (
                      <SessionRow
                        key={r.id}
                        row={r}
                        showProject
                        onFocusNode={onFocusNode}
                        onCloseSession={onCloseSession}
                      />
                    ))}
                  </ul>
                )}
              </section>
            ))
          : groups.map((g) => {
              const key = projectCollapseKey(g.projectId)
              // Selagi memfilter semuanya dibuka: hasil yang disembunyikan di balik baris
              // terlipat terbaca seperti "tidak ada hasil".
              const isCollapsed = filter.trim() === '' && isProjectCollapsed(collapsed, key)
              const sig = signalCounts(g.sessions)
              const head = () => {
                if (projectHeadClickAction(g.isActive) === 'switch') onSelectWorkspace(g.projectId)
                else toggle(key, isCollapsed)
              }
              return (
                <section key={g.projectId} className={g.isActive ? 'ss-group ss-group--active' : 'ss-group'}>
                  <div
                    className="ss-group__head"
                    role="button"
                    tabIndex={0}
                    // Penandanya tidak boleh cuma warna: pembaca layar harus bisa menyebut board
                    // mana yang sedang terbuka di canvas.
                    aria-current={g.isActive ? 'true' : undefined}
                    onClick={head}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      e.stopPropagation()
                      head()
                    }}
                  >
                    <button
                      type="button"
                      className="ss-group__chev"
                      aria-expanded={!isCollapsed}
                      aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${g.projectName}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggle(key, isCollapsed)
                      }}
                    >
                      {isCollapsed ? <ChevronRight aria-hidden /> : <ChevronDown aria-hidden />}
                    </button>
                    <span
                      className="ss-group__monogram"
                      style={g.projectColor ? { background: g.projectColor } : undefined}
                      aria-hidden
                    >
                      {monogram(g.projectName)}
                    </span>
                    <span className="ss-group__name">{g.projectName}</span>
                    {sig.attention > 0 && <span className="ss-signal ss-signal--attention">{sig.attention}</span>}
                    {sig.working > 0 && <span className="ss-signal ss-signal--working">{sig.working}</span>}
                    <span className="ss-group__count">{g.sessions.length}</span>
                  </div>
                  {!isCollapsed && (
                    <ul className="ss-rows ss-group__sessions">
                      {g.sessions.map((r) => (
                        <SessionRow
                          key={r.id}
                          row={r}
                          showProject={false}
                          onFocusNode={onFocusNode}
                          onCloseSession={onCloseSession}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              )
            })}

        {/* Dirender HANYA bila ada isinya — dan di luar gerbang `empty`: board yang seluruh sesinya
            baru saja ditutup adalah justru saat daftar ini paling berguna. Memakai ulang kelas
            `.ss-group__*` + `.ss-row` apa adanya (nol CSS baru): seksi ketiga dengan bahasa visual
            sendiri akan membuat sidebar terbaca seperti tiga panel yang ditempel. */}
        {grouping !== 'nodes' && closedSessions.length > 0 && (
          <section className="ss-group" aria-label="Recently closed">
            <div
              className="ss-group__head"
              role="button"
              tabIndex={0}
              onClick={() => toggle(CLOSED_KEY, closedCollapsed)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                e.stopPropagation()
                toggle(CLOSED_KEY, closedCollapsed)
              }}
            >
              <span className="ss-group__chev" aria-hidden>
                {closedCollapsed ? <ChevronRight /> : <ChevronDown />}
              </span>
              <span className="ss-group__name">Recently closed</span>
              <span className="ss-group__count">{closedSessions.length}</span>
            </div>
            {!closedCollapsed && (
              <ul className="ss-rows ss-status__rows">
                {closedSessions.map((e) => (
                  <li key={e.node.id}>
                    <div
                      className="ss-row"
                      role="button"
                      tabIndex={0}
                      title={e.node.cwd ?? ''}
                      aria-label={`Reopen ${sessionLabel(e.node)}`}
                      onClick={() => onReopenSession?.(e.node.id)}
                      onKeyDown={(ev) => {
                        if (ev.key !== 'Enter' && ev.key !== ' ') return
                        ev.preventDefault()
                        ev.stopPropagation()
                        onReopenSession?.(e.node.id)
                      }}
                    >
                      <span className="ss-row__text">
                        <span className="ss-row__title">{sessionLabel(e.node)}</span>
                        {/* Nama workspace SELALU ikut: daftar ini meruntuhkan dinding workspace
                            seperti mode status, jadi tanpa itu barisnya tidak bilang akan muncul
                            kembali di board mana. */}
                        <span className="ss-meta">{e.workspaceName}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </aside>
  )
}
