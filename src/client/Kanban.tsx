import { useEffect } from 'react'
import type { Node } from '@xyflow/react'
import type { AgentStatus } from '../shared/workspace'
import { groupByStatus, KANBAN_COLUMNS } from './store'
import { Button } from '@/vscode/register'

const TITLE: Record<AgentStatus, string> = { working: 'Working', waiting: 'Waiting', blocked: 'Blocked', done: 'Done' }
// Token warna per status dipetakan ke kelas Tailwind, bukan ke nilai `var(...)` inline: kelasnya
// statis, jadi ikut ter-scan build dan tetap terbaca sebagai satu sumber warna bersama CSS.
const DOT: Record<AgentStatus, string> = {
  working: 'text-[var(--state-working)]',
  waiting: 'text-[var(--state-warning)]',
  blocked: 'text-[var(--state-attention)]',
  done: 'text-[var(--state-queued)]',
}

interface Props {
  nodes: Node[]
  statuses: Record<string, AgentStatus>
  onFocus: (id: string) => void
  onClose: () => void
}

export default function Kanban({ nodes, statuses, onFocus, onClose }: Props) {
  // Jalan keluar kedua: tombol Close bisa saja tertutup chrome lain, dan overlay modal tanpa
  // Escape mengurung pengguna. Pola sama seperti HelpOverlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const groups = groupByStatus(
    nodes.map((n) => ({ id: n.id, data: n.data as { kind?: string; agentId?: string; title?: string } })),
    statuses,
  )

  // Overlay ini saudara .app-main (bukan anaknya) dan .app-shell static, jadi `inset-0` mengukur
  // dari atas viewport: baris header (judul + Close) tenggelam di bawah .tabbar. Turunkan setinggi
  // --tabbar-h, pola sama seperti .controls-cluster di canvas-ui.css; kiri/bawah disisakan untuk activity bar
  // dan status bar supaya overlay ini menutup area editor saja, seperti editor VS Code. z-40 di atas cluster kontrol
  // (26) dan tabbar (30) supaya Close tidak tertimpa tombol mengapung kanan-atas.
  return (
    <div className="absolute top-[var(--tabbar-h,0px)] right-0 bottom-[var(--status-bar-h,0px)] left-[var(--activity-bar-w,0px)] z-40 flex flex-col bg-[var(--vscode-editor-background,var(--canvas-bg))] p-4 font-[family-name:var(--font-ui)] text-[13px] text-[var(--vscode-foreground,var(--text))]">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--vscode-sideBarTitle-foreground,var(--vscode-foreground,var(--text)))]">Board</span>
        <Button type="button" secondary onClick={onClose}>Close</Button>
      </div>
      <div className="flex flex-1 gap-3 overflow-auto">
        {KANBAN_COLUMNS.map((col) => (
          <section key={col} className="kanban-column flex min-w-[180px] flex-1 flex-col gap-1 border border-[var(--vscode-panel-border,var(--border))] bg-[var(--vscode-sideBar-background,var(--panel))] p-1.5">
            <div className="flex h-[22px] items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--vscode-sideBarSectionHeader-foreground,var(--vscode-foreground,var(--text)))]">
              <span aria-hidden="true" className={`codicon codicon-circle-filled shrink-0 ${DOT[col]}`} />
              <span className="flex-1">{TITLE[col]}</span>
              <span className="min-w-4 rounded-[2px] bg-[var(--vscode-badge-background,var(--accent))] px-1 text-center text-[11px] font-normal normal-case leading-4 text-[var(--vscode-badge-foreground,var(--text))]">{groups[col].length}</span>
            </div>
            {groups[col].length === 0 && (
              <div className="px-2 text-[var(--vscode-descriptionForeground,var(--muted))]">No agents</div>
            )}
            {groups[col].map((card) => (
              <button
                key={card.id}
                type="button"
                className="h-[22px] w-full min-w-0 cursor-default truncate border-0 bg-transparent px-2 text-left text-[13px] text-inherit hover:bg-[var(--vscode-list-hoverBackground,var(--hover))] focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-[var(--vscode-focusBorder,var(--accent))]"
                onClick={() => onFocus(card.id)}
              >
                {card.label}
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}
