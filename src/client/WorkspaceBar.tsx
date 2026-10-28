// Header bar aplikasi: brand di kiri, satu tab per workspace, tombol tambah di ujung deretan.
// Bentuknya mengikuti nodeterm v0.4.5 `components/TabBar.tsx` + blok `.tabbar` di
// `src/renderer/styles.css`. Yang SENGAJA tidak diikut: menu kebab per tab — webterm belum punya
// UI rename/hapus workspace sama sekali, jadi caret yang membuka menu kosong adalah janji palsu.
//
// Bar ini MEMAKAN tinggi (bukan pil melayang seperti `.ws-switcher` lama), dan `--tabbar-h` di
// `styles.css` adalah satu-satunya sumber tinggi itu: `canvas-ui.css` memakai token yang sama
// untuk menurunkan cluster kontrol melewatinya.
//
// Dirender SELALU, juga saat belum ada workspace (App merender `Welcome` di bawahnya). Alasannya:
// tombol `+` adalah satu-satunya hal baru di permukaan ini, dan header yang baru muncul setelah
// workspace pertama membuat identitas app berkedip masuk lalu memindahkan canvas 46px ke bawah
// tepat saat pengguna menekan tombol. Strip nol-tab cuma brand + `+`, yang sudah benar sendiri.
import { useMemo } from 'react'
import { Plus, SquareTerminal } from 'lucide-react'
import { buildSessionList } from './sessionList'
import { workspaceTabDot, workspaceTabTitle } from './workspaceTabs'
import type { AgentStatus, Workspace, WsNode } from '../shared/workspace'

export interface WorkspaceBarProps {
  /** Semua workspace, urutan tab mengikuti urutan array ini. */
  workspaces: Workspace[]
  activeId: string | null
  /** Node canvas workspace aktif (live). `null` sebelum workspace pertama termuat. */
  liveActiveNodes: WsNode[] | null
  statuses: Record<string, AgentStatus>
  onSelect: (id: string) => void
  onNewWorkspace: () => void
}

export default function WorkspaceBar({
  workspaces,
  activeId,
  liveActiveNodes,
  statuses,
  onSelect,
  onNewWorkspace,
}: WorkspaceBarProps) {
  // Agregasi yang SAMA dengan sidebar sesi (filter kosong = semua baris). Memakai ulang
  // `buildSessionList` menjaga dot header dan badge sidebar tidak pernah bercerita beda.
  const groups = useMemo(
    () => buildSessionList(workspaces, liveActiveNodes, activeId, statuses, ''),
    [workspaces, liveActiveNodes, activeId, statuses],
  )

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
            <button
              key={g.projectId}
              type="button"
              role="tab"
              aria-selected={g.isActive}
              className={g.isActive ? 'tab tab--active' : 'tab'}
              title={workspaceTabTitle(g)}
              onClick={() => onSelect(g.projectId)}
            >
              <span className={`tab__dot tab__dot--${workspaceTabDot(g)}`} aria-hidden />
              <span className="tab__name">{g.projectName}</span>
            </button>
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
    </header>
  )
}
