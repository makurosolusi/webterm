import type { Node } from '@xyflow/react'
import type { AgentStatus } from '../shared/workspace'
import { groupByStatus, KANBAN_COLUMNS } from './store'

const TITLE: Record<AgentStatus, string> = { working: 'Working', waiting: 'Waiting', blocked: 'Blocked', done: 'Done' }
const HEAD: Record<AgentStatus, string> = { working: '#22c55e', waiting: '#eab308', blocked: '#ef4444', done: '#6b7280' }

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
        <span style={{ color: '#eee', fontSize: 15, fontFamily: 'monospace' }}>Board</span>
        <button onClick={onClose} style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}>Close</button>
      </div>
      <div style={{ display: 'flex', gap: 12, flex: 1, overflow: 'auto' }}>
        {KANBAN_COLUMNS.map((col) => (
          <div key={col} style={{ flex: 1, minWidth: 180, background: '#181818', border: '1px solid #333', borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ccc', fontSize: 12, fontFamily: 'monospace' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: HEAD[col] }} />
              <span style={{ flex: 1 }}>{TITLE[col]}</span>
              <span style={{ color: '#888' }}>{groups[col].length}</span>
            </div>
            {groups[col].map((card) => (
              <button
                key={card.id}
                onClick={() => onFocus(card.id)}
                style={{ textAlign: 'left', background: '#2a2a2a', color: '#eee', border: '1px solid #3a3a3a', borderRadius: 4, padding: '6px 8px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
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
