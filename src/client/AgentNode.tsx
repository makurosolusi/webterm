import { useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { AGENTS } from '../shared/workspace'
import type { AgentId } from '../shared/workspace'
import TerminalCore from './TerminalCore'
import { send } from './ws'

export default function AgentNode({ data }: NodeProps) {
  const { id, cmd, cwd, agentId, color, title } = data as {
    id: string; cmd?: string; cwd?: string; agentId?: AgentId; color?: string; title?: string
  }
  // Restart bumps the key so TerminalCore remounts and re-sends `open` with the
  // same cmd; the prior `close` kills the old PTY (FIFO on one socket).
  const [gen, setGen] = useState(0)

  const builtin = agentId && agentId !== 'custom' ? AGENTS[agentId] : undefined
  const swatch = color ?? builtin?.color ?? '#888'
  const label = title ?? builtin?.label ?? agentId ?? 'agent'

  const restart = () => {
    send({ t: 'close', id })
    setGen((g) => g + 1)
  }

  return (
    <div style={{ width: 480, height: 320, background: '#1e1e1e', borderRadius: 6, overflow: 'hidden', border: '1px solid #333' }}>
      <div style={{ height: 24, background: '#2a2a2a', color: '#ccc', fontSize: 11, lineHeight: '24px', padding: '0 8px', fontFamily: 'monospace', cursor: 'grab', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: swatch, flex: '0 0 auto' }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <button
          className="nodrag"
          onClick={restart}
          style={{ background: '#444', color: '#eee', border: 'none', borderRadius: 4, fontSize: 10, padding: '1px 6px', cursor: 'pointer' }}
        >
          Restart
        </button>
      </div>
      <div style={{ height: 'calc(100% - 24px)', width: '100%' }}>
        <TerminalCore key={gen} id={id} cmd={cmd} cwd={cwd} />
      </div>
    </div>
  )
}
