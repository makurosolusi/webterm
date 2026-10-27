import type { NodeProps } from '@xyflow/react'
import TerminalCore from './TerminalCore'

export default function TerminalNode({ data }: NodeProps) {
  const { id, cwd } = data as { id: string; cwd?: string }

  return (
    <div style={{ width: 480, height: 320, background: '#1e1e1e', borderRadius: 6, overflow: 'hidden', border: '1px solid #333' }}>
      <div style={{ height: 24, background: '#2a2a2a', color: '#888', fontSize: 11, lineHeight: '24px', padding: '0 8px', fontFamily: 'monospace', cursor: 'grab' }}>
        {id.slice(0, 8)}
      </div>
      <div style={{ height: 'calc(100% - 24px)', width: '100%' }}>
        <TerminalCore id={id} cwd={cwd} />
      </div>
    </div>
  )
}
