import { useEffect } from 'react'
import type { Node } from '@xyflow/react'
import type { AgentStatus } from '../shared/workspace'
import { groupByStatus, KANBAN_COLUMNS } from './store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const TITLE: Record<AgentStatus, string> = { working: 'Working', waiting: 'Waiting', blocked: 'Blocked', done: 'Done' }
// Token warna per status dipetakan ke kelas Tailwind, bukan ke nilai `var(...)` inline: kelasnya
// statis, jadi ikut ter-scan build dan tetap terbaca sebagai satu sumber warna bersama CSS.
const DOT: Record<AgentStatus, string> = {
  working: 'bg-[var(--state-working)]',
  waiting: 'bg-[var(--state-warning)]',
  blocked: 'bg-[var(--state-attention)]',
  done: 'bg-[var(--state-queued)]',
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
  // --tabbar-h, pola sama seperti .controls-cluster di canvas-ui.css. z-40 di atas cluster kontrol
  // (26) dan tabbar (30) supaya Close tidak tertimpa tombol mengapung kanan-atas.
  return (
    <div className="absolute top-[var(--tabbar-h,0px)] right-0 bottom-0 left-0 z-40 flex flex-col bg-black/55 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[15px] text-foreground">Board</span>
        <Button type="button" onClick={onClose}>Close</Button>
      </div>
      <div className="flex flex-1 gap-3 overflow-auto">
        {KANBAN_COLUMNS.map((col) => (
          <Card key={col} className={cn('kanban-column min-w-[180px] flex-1 gap-2 rounded-md border border-border bg-card p-2.5')}>
            <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
              <Badge variant="outline" aria-hidden="true" className={cn('h-[9px] w-[9px] shrink-0 rounded-full border-0 p-0', DOT[col])} />
              <span className="flex-1">{TITLE[col]}</span>
              <span>{groups[col].length}</span>
            </div>
            {groups[col].map((card) => (
              <Button
                key={card.id}
                type="button"
                variant="ghost"
                className="h-auto w-full min-w-0 cursor-pointer justify-start overflow-hidden truncate rounded border border-border bg-secondary px-2 py-1.5 text-left font-mono text-xs text-foreground hover:bg-secondary hover:text-foreground"
                onClick={() => onFocus(card.id)}
              >
                {card.label}
              </Button>
            ))}
          </Card>
        ))}
      </div>
    </div>
  )
}
