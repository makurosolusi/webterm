import { ReactFlow, Background, BackgroundVariant, MiniMap } from '@xyflow/react'
import type { Node, Edge, NodeChange, EdgeChange, Connection, ReactFlowInstance, OnMoveEnd } from '@xyflow/react'
import { useMemo, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import ContextEdge from './ContextEdge'
import { connectionLineStyle, withTouchedAccent } from './canvasStyle'
import './canvas-ui.css'
import { nodeTypes } from './nodeTypes'
import McpAppsWatcher from './mcpapps/McpAppsWatcher'
import { DROP_URL_TYPES, urlFromDrop } from './browser.dropUrl'
import { useNodeActions } from './nodeActions'
import { useNodeResizeWiring } from './nodeResize/useNodeResizeWiring'
import { QuickDrag } from './quickDrag/useQuickDrag'
import { useRecordLegacyClaudeProfiles } from './claudeLauncher/useLegacyClaudeProfiles'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { clampSetting } from '../shared/settings.ranges'
import { resolveCanvasBackground } from '../shared/canvasBackground.schema'
import { CanvasBackgroundLayer, useWallpaper } from './CanvasBackgroundLayer'
import type { Viewport } from '../shared/workspace'
import { closestNodeRoot } from './nodeRoot'
import NodeMaximizeOverlay from './nodeMaximize.overlay'
import { beforeNodeDelete, useCancelNodeCloseOnUnmount } from './nodeCloseConfirm'
import { useCentralAct } from './centralAct.store'
import { useHandleMenu } from './handleMenu.hook'
import CentralActMount, { markTouched } from './centralAct.layer'

const edgeTypes = { context: ContextEdge }

interface CanvasProps {
  rf: RefObject<ReactFlowInstance | null>
  nodes: Node[]
  edges: Edge[]
  settings: Settings
  /** Settings loaded: legacy Claude nodes can record the default launch profile. */
  hydrated: boolean
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
  rf, nodes: boardNodes, edges: boardEdges, settings, hydrated, viewport, locked, nodeColor, syncViewport,
  onNodesChange, onEdgesChange, onConnect, onMoveEnd, onPaneContextMenu,
}: CanvasProps) {
  useRecordLegacyClaudeProfiles(boardNodes, hydrated, settings, rf)
  // Central's recent actions: classes on the touched nodes/cables (centralAct.css); the camera and selection are left alone.
  const { entries: acted } = useCentralAct()
  const { nodes, edges } = useMemo(() => markTouched(boardNodes, boardEdges, acted), [boardNodes, boardEdges, acted])
  const touchedIds = useMemo(() => new Set(acted.map((e) => e.nodeId)), [acted])
  // undefined = flag browser mati: handler drop tidak melakukan apa pun (termasuk tanpa preventDefault).
  const { openBrowserAt, workspaceId, spawn } = useNodeActions()
  // Click a bridge handle / release a cable on the pane -> spawn menu (needs connectOnClick off below).
  const handleMenu = useHandleMenu({
    nodes: boardNodes, settings, spawn,
    // Gentle: frame both ends, never zoom in past where the user already is.
    frame: (ids) => { const i = rf.current; void i?.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.3, duration: 300, maxZoom: i.getZoom() }) },
  })
  // Wallpaper sits behind the pane (no pan/zoom); workspace override -> global -> default.
  const wallpaper = useWallpaper(resolveCanvasBackground(settings, workspaceId))
  useNodeResizeWiring(locked, rf)
  useCancelNodeCloseOnUnmount()
  // Drop di atas node (mis. xterm) milik node itu, bukan pemicu node browser baru.
  const overNode = (e: DragEvent) => closestNodeRoot(e.target as HTMLElement) !== null
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
    <>
    <CanvasBackgroundLayer bg={wallpaper.shown} imageUrl={wallpaper.imageUrl} />
    <ReactFlow
      className={wallpaper.active ? 'canvas--wallpaper' : undefined}
      // Cable + arrowhead color (EDGE_STROKE / `.react-flow__marker` read it); default = theme token.
      style={settings.edgeColor === 'default' ? undefined : ({ '--edge-color': settings.edgeColor } as CSSProperties)}
      nodes={nodes}
      nodeTypes={nodeTypes}
      edges={edges}
      edgeTypes={edgeTypes}
      connectionLineStyle={connectionLineStyle(settings.edgeWidth)}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      connectOnClick={false}
      onConnectStart={handleMenu.onConnectStart}
      onConnectEnd={handleMenu.onConnectEnd}
      // Every user node close (× buttons, tabs, sessions panel, Delete key) asks first: nodeCloseConfirm.tsx.
      onBeforeDelete={beforeNodeDelete}
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
        <Background variant={BackgroundVariant.Dots} gap={gridSize} size={2.5} color={wallpaper.dotColor} />
      )}
      {/* Adds an App node when an agent publishes an MCP Apps ui:// view (mcpapps/McpAppsWatcher.tsx). */}
      <McpAppsWatcher />
      {/* Hold ⌘⌃ (preset) and drag anywhere on a node to move or resize it (quickDrag/useQuickDrag.ts). */}
      <QuickDrag preset={settings.quickDrag} />
      <NodeMaximizeOverlay nodes={nodes} />
      {/* Chips on touched nodes + the one tray notice (centralAct.layer.tsx). */}
      <CentralActMount rf={rf} nodes={nodes} workspaceId={workspaceId ?? null} />
      <MiniMap
        className="minimap-dock" pannable zoomable nodeColor={withTouchedAccent(nodeColor, touchedIds)}
        // `p` sudah koordinat flow: viewBox minimap digambar di ruang itu, jadi tak perlu dikonversi.
        // `setCenter` tanpa `zoom` jatuh ke maxZoom, bukan zoom sekarang — klik cuma boleh
        // memindahkan titik pandang, jadi zoom berjalan diteruskan eksplisit.
        onClick={(_, p) => {
          const vp = rf.current?.getViewport()
          if (vp) { rf.current?.setCenter(p.x, p.y, { zoom: vp.zoom, duration: 300 }); syncViewport(320) }
        }}
      />
    </ReactFlow>
    {handleMenu.menu}
    </>
  )
}
