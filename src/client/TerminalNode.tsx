import type { NodeProps } from '@xyflow/react'
import { NodeResizer } from '@xyflow/react'
import TerminalCore from './TerminalCore'

export default function TerminalNode({ data, selected }: NodeProps) {
  const { id, cwd } = data as { id: string; cwd?: string }

  return (
    <>
      <NodeResizer isVisible={!!selected} minWidth={240} minHeight={160} color="#0a84ff" />
      <div className={`term-node${selected ? ' term-node--selected' : ''}`}>
        <div className="node-header"><span className="node-title">{id.slice(0, 8)}</span></div>
        <div style={{ flex: 1, minHeight: 0 }}><TerminalCore id={id} cwd={cwd} /></div>
      </div>
    </>
  )
}
