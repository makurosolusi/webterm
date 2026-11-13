// The only place NodeResizer is used (nodeResizePolicy.test.ts enforces it). Edges and corners always
// resize (OS windows, VS Code sashes, node editors): invisible hit strips that only change the cursor,
// so selecting or clicking a node never shows handles, and no header carries a resize button. Resize
// mode (the "Node: Resize Focused Node" command) additionally draws the visible handles.
import { useEffect, useRef } from 'react'
import { NodeResizer, useNodeId, type NodeResizerProps } from '@xyflow/react'
import { nodeIdOf } from '../nodeRoot'
import { useNodeHost } from '../tabLayout.context'
import { exitNodeResize, setNodeResizeLimits, useNodeResizeState } from './nodeResize.store'

/** NodeResizer's own default when a node passes no minimum. */
const RESIZER_DEFAULT_MIN = 10

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

const targetNodeId = (t: EventTarget | null): string | undefined => (t instanceof Element ? nodeIdOf(t) : undefined)

export interface NodeLayoutResizerProps extends Omit<NodeResizerProps, 'isVisible' | 'nodeId'> {
  /** A collapsed node cannot be resized; collapsing ends resize mode. */
  collapsed?: boolean
  /** Double-clicking the right edge in resize mode runs this (auto-fit the width, like a column). */
  onFitWidth?: () => void
}

/** Invisible edge resize, plus visible handles in this node's resize mode (ended on Esc, outside press, typing, collapse or removal). */
export function NodeLayoutResizer({ collapsed, onFitWidth, color, ...props }: NodeLayoutResizerProps) {
  const id = useNodeId()
  const { editingId, locked } = useNodeResizeState()
  const { inTab, maximized } = useNodeHost()
  const editing = id !== null && editingId === id && !collapsed
  // Tab mode and a maximized node keep their canvas layout; the dock lock freezes it.
  const edges = id !== null && !collapsed && !locked && !inTab && !maximized
  const fitRef = useRef(onFitWidth)
  fitRef.current = onFitWidth

  useEffect(() => { if (collapsed && id) exitNodeResize(id) }, [collapsed, id])
  const minWidth = props.minWidth ?? RESIZER_DEFAULT_MIN
  const minHeight = props.minHeight ?? RESIZER_DEFAULT_MIN
  useEffect(() => {
    if (!id) return
    setNodeResizeLimits(id, { minWidth, minHeight, collapsed: !!collapsed })
    return () => setNodeResizeLimits(id, null)
  }, [id, minWidth, minHeight, collapsed])
  // Unmount = the node was deleted (or left the canvas): its mode must not outlive it.
  useEffect(() => () => { if (id) exitNodeResize(id) }, [id])

  useEffect(() => {
    if (!editing || !id) return
    // Capture phase: surfaces like xterm or Monaco stop their keys before they bubble.
    // A press on the handles is inside the node, so dragging them keeps the mode.
    const onPointerDown = (e: PointerEvent): void => { if (targetNodeId(e.target) !== id) exitNodeResize(id) }
    const onDoubleClick = (e: MouseEvent): void => {
      const t = e.target
      if (fitRef.current && t instanceof Element && t.closest('.react-flow__resize-control.line.right') && targetNodeId(t) === id) fitRef.current()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') return exitNodeResize(id)
      // Chords (the resize shortcut itself, copy) are not typing; neither are header controls.
      if (e.metaKey || e.ctrlKey || e.altKey || MODIFIER_KEYS.has(e.key)) return
      if (targetNodeId(e.target) === id && !(e.target as Element).closest('.node-header')) exitNodeResize(id)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('dblclick', onDoubleClick, true)
    return () => {
      document.removeEventListener('dblclick', onDoubleClick, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [editing, id])

  // `color` is applied inline by NodeResizer, so the invisible strips must not get it.
  if (editing) return <NodeResizer isVisible color={color} {...props} />
  return <NodeResizer isVisible={edges} lineClassName="node-edge-resize" handleClassName="node-edge-resize" {...props} />
}
