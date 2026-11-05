import { ReactFlow, Background, BackgroundVariant, MiniMap } from '@xyflow/react'
import type { Node, Edge, NodeChange, EdgeChange, Connection, ReactFlowInstance, OnMoveEnd } from '@xyflow/react'
import type { DragEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react'
import ContextEdge from './ContextEdge'
import { nodeTypes } from './nodeTypes'
import McpAppsWatcher from './mcpapps/McpAppsWatcher'
import { DROP_URL_TYPES, urlFromDrop } from './browser.dropUrl'
import { useNodeActions } from './nodeActions'
import { useNodeResizeWiring } from './nodeResize/useNodeResizeWiring'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { clampSetting } from '../shared/settings.ranges'
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
  // undefined = flag browser mati: handler drop tidak melakukan apa pun (termasuk tanpa preventDefault).
  const { openBrowserAt } = useNodeActions()
  useNodeResizeWiring(locked, rf)
  // Drop di atas node (mis. xterm) milik node itu, bukan pemicu node browser baru.
  const overNode = (e: DragEvent) => (e.target as HTMLElement).closest('.react-flow__node') !== null
  const onDragOver = (e: DragEvent) => {
    if (openBrowserAt && !overNode(e) && DROP_URL_TYPES.some((t) => e.dataTransfer.types.includes(t))) e.preventDefault()
  }
  const onDrop = (e: DragEvent) => {
    if (!openBrowserAt || overNode(e) || !DROP_URL_TYPES.some((t) => e.dataTransfer.types.includes(t))) return
    // Selalu dicegah: dragover sudah menerima drop ini, kalau tidak peramban menavigasi tab ke teks yang dijatuhkan.
    e.preventDefault()
    const url = urlFromDrop(e.dataTransfer)
    const at = rf.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    if (url && at) openBrowserAt({ url, at })
  }
  // 0 / NaN / di luar rentang tak boleh sampai ke React Flow: grid 0 menghasilkan NaN saat snap.
  const gridSize = clampSetting('gridSize', settings.gridSize, DEFAULT_SETTINGS.gridSize)
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
      onDragOver={onDragOver}
      onDrop={onDrop}
      onInit={(i) => (rf.current = i)}
      defaultViewport={viewport ?? DEFAULT_VIEWPORT}
      fitView={false}
      minZoom={0.01}
      maxZoom={2}
      snapToGrid={settings.snapToGrid}
      snapGrid={[gridSize, gridSize]}
      panOnDrag={!locked}
      panOnScroll={!locked}
      zoomOnPinch={!locked}
      zoomOnScroll={false}
      proOptions={{ hideAttribution: true }}
    >
      {settings.canvasDots && (
        <Background variant={BackgroundVariant.Dots} gap={gridSize} size={2.5} color="var(--canvas-dot)" />
      )}
      {/* Adds an App node when an agent publishes an MCP Apps ui:// view (mcpapps/McpAppsWatcher.tsx). */}
      <McpAppsWatcher />
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
