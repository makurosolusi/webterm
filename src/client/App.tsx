import { useCallback, useMemo, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  applyNodeChanges,
} from '@xyflow/react'
import type { Node, NodeChange } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import TerminalNode from './TerminalNode'
import { loadNodes, saveNodes, addNode } from './store'
import type { TermNode } from './store'
import { send } from './ws'

const nodeTypes = { terminal: TerminalNode }

function toFlow(t: TermNode): Node {
  return { id: t.id, type: 'terminal', position: { x: t.x, y: t.y }, data: { id: t.id } }
}

function toTerm(n: Node): TermNode {
  return { id: n.id, x: n.position.x, y: n.position.y }
}

export default function App() {
  const [nodes, setNodes] = useState<Node[]>(() => loadNodes(localStorage).map(toFlow))

  const persist = useCallback((ns: Node[]) => saveNodes(localStorage, ns.map(toTerm)), [])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((prev) => {
        const next = applyNodeChanges(changes, prev)
        // Persist on drag-stop (position settled) and on removal; also close removed terms.
        const settled = changes.some((c) => (c.type === 'position' && !c.dragging) || c.type === 'remove')
        if (changes.some((c) => c.type === 'remove')) {
          for (const c of changes) if (c.type === 'remove') send({ t: 'close', id: c.id })
        }
        if (settled) persist(next)
        return next
      })
    },
    [persist]
  )

  const onAdd = useCallback(() => {
    setNodes((prev) => {
      const n = prev.length
      const t: TermNode = { id: crypto.randomUUID(), x: 80 + n * 40, y: 80 + n * 40 }
      const terms = addNode(prev.map(toTerm), t)
      saveNodes(localStorage, terms)
      return terms.map(toFlow)
    })
  }, [])

  const btnStyle = useMemo<React.CSSProperties>(
    () => ({
      position: 'absolute', zIndex: 10, top: 12, left: 12,
      padding: '8px 14px', background: '#2563eb', color: '#fff',
      border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13,
    }),
    []
  )

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#111' }}>
      <button style={btnStyle} onClick={onAdd}>+ Terminal</button>
      <ReactFlow nodes={nodes} nodeTypes={nodeTypes} onNodesChange={onNodesChange} fitView={false}>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}
