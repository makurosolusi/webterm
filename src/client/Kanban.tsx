import { useEffect } from 'react'
import type { Node } from '@xyflow/react'
import type { AgentStatus } from '../shared/workspace'
import { groupByStatus, KANBAN_COLUMNS } from './store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const TITLE: Record<AgentStatus, string> = { working: 'Working', waiting: 'Waiting', blocked: 'Blocked', done: 'Done' }
const HEAD: Record<AgentStatus, string> = { working: 'var(--state-working)', waiting: 'var(--state-warning)', blocked: 'var(--state-attention)', done: 'var(--state-queued)' }

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

  // Overlay ini saudara .app-main (bukan anaknya) dan .app-shell static, jadi `inset: 0` mengukur
  // dari atas viewport: baris header (judul + Close) tenggelam di bawah .tabbar. Turunkan setinggi
  // --tabbar-h, pola sama seperti .controls-cluster di canvas-ui.css. zIndex di atas cluster
  // kontrol (26) dan tabbar (30) supaya Close tidak tertimpa tombol mengapung kanan-atas.
  return (
    <div style={{ position: 'absolute', top: 'var(--tabbar-h, 0px)', left: 0, right: 0, bottom: 0, zIndex: 40, background: 'rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ color: 'var(--text)', fontSize: 15, fontFamily: 'monospace' }}>Board</span>
        <Button type="button" onClick={onClose}>Close</Button>
      </div>
      <div style={{ display: 'flex', gap: 12, flex: 1, overflow: 'auto' }}>
        {KANBAN_COLUMNS.map((col) => (
          <Card key={col} className={cn('kanban-column')} style={{ flex: 1, minWidth: 180, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 12, fontFamily: 'monospace' }}>
              <Badge variant="outline" style={{ width: 9, height: 9, padding: 0, borderRadius: '50%', background: HEAD[col] }} aria-hidden="true" />
              <span style={{ flex: 1 }}>{TITLE[col]}</span>
              <span style={{ color: 'var(--muted)' }}>{groups[col].length}</span>
            </div>
            {groups[col].map((card) => (
              <Button
                key={card.id}
                type="button"
                variant="ghost"
                className="kanban-card"
                onClick={() => onFocus(card.id)}
                style={{ textAlign: 'left', background: 'var(--raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
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
