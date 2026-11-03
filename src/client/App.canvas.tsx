import { ReactFlow, Background, BackgroundVariant, MiniMap } from '@xyflow/react'
import type { Node, Edge, NodeChange, EdgeChange, Connection, ReactFlowInstance, OnMoveEnd } from '@xyflow/react'
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react'
import ContextEdge from './ContextEdge'
import { nodeTypes } from './nodeTypes'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Settings } from '../shared/settings'
import type { Viewport } from '../shared/workspace'

const edgeTypes = { context: ContextEdge }

interface CanvasProps {
  rf: RefObject<ReactFlowInstance | null>
  nodes: Node[]
  edges: Edge[]
  settings: Settings
  viewport: Viewport | undefined
  locked: boolean
  nodeColor: (n: Node) => string
  syncViewport: (ms: number) => void
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onConnect: (c: Connection) => void
  onMoveEnd: OnMoveEnd
  onPaneContextMenu: (e: ReactMouseEvent | MouseEvent) => void
}

/** Canvas React Flow board aktif beserta background dan minimap-nya. */
export default function BoardCanvas({
  rf, nodes, edges, settings, viewport, locked, nodeColor, syncViewport,
  onNodesChange, onEdgesChange, onConnect, onMoveEnd, onPaneContextMenu,
}: CanvasProps) {
  return (
    <ReactFlow
      nodes={nodes}
      nodeTypes={nodeTypes}
      edges={edges}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onEdgeDoubleClick={(_, e) => { void rf.current?.deleteElements({ edges: [{ id: e.id }] }) }}
      onMoveEnd={onMoveEnd}
      onPaneContextMenu={onPaneContextMenu}
      onInit={(i) => (rf.current = i)}
      defaultViewport={viewport ?? DEFAULT_VIEWPORT}
      fitView={false}
      minZoom={0.01}
      maxZoom={2}
      snapToGrid={settings.snapToGrid}
      snapGrid={[settings.gridSize, settings.gridSize]}
      panOnDrag={!locked}
      panOnScroll={!locked}
      zoomOnPinch={!locked}
      zoomOnScroll={false}
      proOptions={{ hideAttribution: true }}
    >
      {settings.canvasDots && (
        <Background variant={BackgroundVariant.Dots} gap={settings.gridSize} size={2.5} color="var(--canvas-dot)" />
      )}
      <MiniMap
        className="minimap-dock" pannable zoomable nodeColor={nodeColor}
        // `p` sudah koordinat flow: viewBox minimap digambar di ruang itu, jadi tak perlu dikonversi.
        // `setCenter` tanpa `zoom` jatuh ke maxZoom, bukan zoom sekarang — klik cuma boleh
        // memindahkan titik pandang, jadi zoom berjalan diteruskan eksplisit.
        onClick={(_, p) => {
          const vp = rf.current?.getViewport()
          if (vp) { rf.current?.setCenter(p.x, p.y, { zoom: vp.zoom, duration: 300 }); syncViewport(320) }
        }}
      />
    </ReactFlow>
  )
}
