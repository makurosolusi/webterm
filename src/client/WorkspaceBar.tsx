// Header bar aplikasi: brand di kiri, satu tab per workspace, tombol tambah di ujung deretan.
// Bentuknya mengikuti nodeterm v0.4.5 `components/TabBar.tsx` + blok `.tabbar` di
// `src/renderer/styles.css`: dot + nama + kebab (⋮) di tepi kanan tab, rename sebagai input INLINE
// di dalam tab (Enter simpan, Escape batal, blur simpan), dan menu yang menutup sendiri saat
// pointer mendarat di luar. Menu kebab ini satu-satunya permukaan rename/hapus workspace di
// webterm — tanpa dia, workspace yang salah dibuat tidak bisa dibuang dari UI sama sekali.
//
// Bar ini MEMAKAN tinggi (bukan pil melayang seperti `.ws-switcher` lama), dan `--tabbar-h` di
// `styles.css` adalah satu-satunya sumber tinggi itu: `canvas-ui.css` memakai token yang sama
// untuk menurunkan cluster kontrol melewatinya.
//
// Dirender SELALU, juga saat belum ada workspace (App merender `Welcome` di bawahnya). Alasannya:
// tombol `+` adalah satu-satunya hal baru di permukaan ini, dan header yang baru muncul setelah
// workspace pertama membuat identitas app berkedip masuk lalu memindahkan canvas 46px ke bawah
// tepat saat pengguna menekan tombol. Strip nol-tab cuma brand + `+`, yang sudah benar sendiri.
import { useMemo, useState } from 'react'
import { MoreVertical, Plus, SquareTerminal } from 'lucide-react'
import NodeContextMenu from './NodeContextMenu'
import { buildSessionList } from './sessionList'
import { workspaceTabDot, workspaceTabTitle } from './workspaceTabs'
import { deleteWorkspaceMessage, normalizeWorkspaceName } from './workspaceMenu'
import type { AgentStatus, Workspace, WsNode } from '../shared/workspace'

/** Jarak menu dari tepi bawah tombol kebab-nya, seperti nodeterm (`openMenu`: `r.bottom + 4`). */
const MENU_GAP = 4

export interface WorkspaceBarProps {
  /** Semua workspace, urutan tab mengikuti urutan array ini. */
  workspaces: Workspace[]
  activeId: string | null
  /** Node canvas workspace aktif (live). `null` sebelum workspace pertama termuat. */
  liveActiveNodes: WsNode[] | null
  statuses: Record<string, AgentStatus>
  onSelect: (id: string) => void
  onNewWorkspace: () => void
  /** Nama sudah dinormalkan (trim, tidak pernah kosong) sebelum sampai ke sini. */
  onRenameWorkspace: (id: string, name: string) => void
  /** Sudah dikonfirmasi pengguna di sini — pemanggil langsung menghapus. */
  onDeleteWorkspace: (id: string) => void
}

export default function WorkspaceBar({
  workspaces,
  activeId,
  liveActiveNodes,
  statuses,
  onSelect,
  onNewWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
}: WorkspaceBarProps) {
  // Agregasi yang SAMA dengan sidebar sesi (filter kosong = semua baris). Memakai ulang
  // `buildSessionList` menjaga dot header dan badge sidebar tidak pernah bercerita beda.
  const groups = useMemo(
    () => buildSessionList(workspaces, liveActiveNodes, activeId, statuses, ''),
    [workspaces, liveActiveNodes, activeId, statuses],
  )

  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const menuGroup = menu ? groups.find((g) => g.projectId === menu.id) : undefined

  const commitRename = (): void => {
    if (!editingId) return
    const name = normalizeWorkspaceName(draft)
    const before = workspaces.find((w) => w.id === editingId)?.name
    // Draft kosong/spasi, atau nama yang tidak berubah: tutup editor tanpa menulis apa-apa — PUT
    // workspace itu mahal (seluruh board ikut dikirim) dan rename yang sama tidak membawa apa pun.
    if (name && name !== before) onRenameWorkspace(editingId, name)
    setEditingId(null)
  }

  const startRename = (id: string, current: string): void => {
    setEditingId(id)
    setDraft(current)
  }

  return (
    <header className="tabbar">
      <div className="brand">
        <SquareTerminal className="brand__mark" aria-hidden />
        <span className="brand__name">webterm</span>
      </div>

      {/* `+` SAUDARA strip, bukan anaknya: dengan 10+ workspace strip yang menggulung tidak boleh
          membawa tombol tambah keluar layar (nodeterm issue #375). */}
      <div className="tabbar__projects">
        <div className="tabbar__tabs" role="tablist" aria-label="Workspaces">
          {groups.map((g) => (
            // `div`, bukan `button` seperti dulu: tab sekarang MEMUAT tombol (kebab) dan sebuah
            // input, dan button di dalam button adalah HTML tidak sah — browser memecah DOM-nya
            // sendiri. Keyboard tetap sampai ke tab lewat tabIndex + Enter/Space, yang semula
            // didapat gratis dari elemen button.
            <div
              key={g.projectId}
              role="tab"
              tabIndex={0}
              aria-selected={g.isActive}
              className={g.isActive ? 'tab tab--active' : 'tab'}
              title={workspaceTabTitle(g)}
              onClick={() => onSelect(g.projectId)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault() // Space menggulung halaman
                onSelect(g.projectId)
              }}
            >
              <span className={`tab__dot tab__dot--${workspaceTabDot(g)}`} aria-hidden />
              {editingId === g.projectId ? (
                <input
                  className="tab__edit"
                  value={draft}
                  autoFocus
                  spellCheck={false}
                  aria-label="Workspace name"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Tab induk ikut mendengar Enter/Space; tanpa ini mengetik spasi di dalam nama
                    // juga memilih workspace dan Enter melakukannya dua kali.
                    e.stopPropagation()
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="tab__name">{g.projectName}</span>
              )}

              {editingId !== g.projectId && (
                <span className="tab__actions">
                  <button
                    type="button"
                    className="tab__caret"
                    title="Workspace options"
                    aria-label="Workspace options"
                    onClick={(e) => {
                      // Klik kebab TIDAK berpindah workspace (nodeterm sama): menu ini juga jalan
                      // untuk tab yang tidak aktif, dan membuka menu bukan permintaan pindah board.
                      e.stopPropagation()
                      // Tanpa cabang toggle "klik lagi untuk menutup": `NodeContextMenu` sudah
                      // menutup diri pada pointerdown mana pun lewat listener CAPTURE di window,
                      // yang jalan sebelum handler ini — jadi menu selalu sudah tertutup di sini
                      // dan cabang itu tidak akan pernah benar. Penutupnya: klik di luar + Escape.
                      const r = e.currentTarget.getBoundingClientRect()
                      setMenu({ id: g.projectId, x: r.left, y: r.bottom + MENU_GAP })
                    }}
                  >
                    <MoreVertical aria-hidden />
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          className="tab__add"
          title="New workspace"
          aria-label="New workspace"
          onClick={onNewWorkspace}
        >
          <Plus aria-hidden />
        </button>
      </div>

      {menu && menuGroup && (
        <NodeContextMenu
          x={menu.x}
          y={menu.y}
          rows={[
            { label: 'Rename', onClick: () => startRename(menuGroup.projectId, menuGroup.projectName) },
            {
              label: 'Delete',
              danger: true,
              onClick: () => {
                // Hapus TIDAK bisa dibatalkan (row workspace + seluruh board tersimpannya hilang),
                // jadi ia wajib lewat satu langkah konfirmasi — nodeterm memakai `ConfirmDialog`
                // miliknya sendiri, webterm belum punya primitif dialog sama sekali, dan
                // `confirm()` native adalah satu-satunya modal yang tidak bisa terklik sambil lalu.
                // Kalau browser menekan dialognya, hasilnya `false` → tidak menghapus apa pun.
                if (window.confirm(deleteWorkspaceMessage(menuGroup.projectName, menuGroup.sessions.length))) {
                  onDeleteWorkspace(menuGroup.projectId)
                }
              },
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </header>
  )
}
