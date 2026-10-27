import type { Node } from '@xyflow/react'
import type { AgentStatus } from '../shared/workspace'
import { groupByStatus, KANBAN_COLUMNS } from './store'

const TITLE: Record<AgentStatus, string> = { working: 'Working', waiting: 'Waiting', blocked: 'Blocked', done: 'Done' }
const HEAD: Record<AgentStatus, string> = { working: 'var(--state-working)', waiting: 'var(--state-warning)', blocked: 'var(--state-attention)', done: 'var(--state-queued)' }

interface Props {
  nodes: Node[]
  statuses: Record<string, AgentStatus>
  onFocus: (id: string) => void
  onClose: () => void
}

export default function Kanban({ nodes, statuses, onFocus, onClose }: Props) {
  const groups = groupByStatus(
    nodes.map((n) => ({ id: n.id, data: n.data as { kind?: string; agentId?: string; title?: string } })),
    statuses,
  )

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 20, background: 'rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ color: 'var(--text)', fontSize: 15, fontFamily: 'monospace' }}>Board</span>
        <button className="btn btn--accent" onClick={onClose}>Close</button>
      </div>
      <div style={{ display: 'flex', gap: 12, flex: 1, overflow: 'auto' }}>
        {KANBAN_COLUMNS.map((col) => (
          <div key={col} style={{ flex: 1, minWidth: 180, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 12, fontFamily: 'monospace' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: HEAD[col] }} />
              <span style={{ flex: 1 }}>{TITLE[col]}</span>
              <span style={{ color: 'var(--muted)' }}>{groups[col].length}</span>
            </div>
            {groups[col].map((card) => (
              <button
                key={card.id}
                onClick={() => onFocus(card.id)}
                style={{ textAlign: 'left', background: 'var(--raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {card.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
