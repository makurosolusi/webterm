// The only place NodeResizer is used (nodeResizePolicy.test.ts enforces it). Handles show only
// while the node is in resize mode, which the user enters on purpose with NodeResizeToggle or the
// "Node: Resize Focused Node" command; selecting or clicking a node never shows them.
import { useEffect } from 'react'
import { NodeResizer, useNodeId, type NodeResizerProps } from '@xyflow/react'
import { nodeIdOf } from '../nodeRoot'
import { IconButton } from '@/components/ui/icon-button'
import type { VscodeMenuItem } from '../components/vscode/vscodeMenu'
import { RESIZE_COMMAND_ID, exitNodeResize, toggleNodeResize, useNodeResizeState } from './nodeResize.store'

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

const targetNodeId = (t: EventTarget | null): string | undefined => (t instanceof Element ? nodeIdOf(t) : undefined)

export interface NodeLayoutResizerProps extends Omit<NodeResizerProps, 'isVisible' | 'nodeId'> {
  /** A collapsed node cannot be resized; collapsing ends resize mode. */
  collapsed?: boolean
}

/** NodeResizer shown only in this node's resize mode; ends the mode on Esc, outside press, typing, collapse or removal. */
export function NodeLayoutResizer({ collapsed, ...props }: NodeLayoutResizerProps) {
  const id = useNodeId()
  const { editingId } = useNodeResizeState()
  const editing = id !== null && editingId === id && !collapsed

  useEffect(() => { if (collapsed && id) exitNodeResize(id) }, [collapsed, id])
  // Unmount = the node was deleted (or left the canvas): its mode must not outlive it.
  useEffect(() => () => { if (id) exitNodeResize(id) }, [id])

  useEffect(() => {
    if (!editing || !id) return
    // Capture phase: surfaces like xterm or Monaco stop their keys before they bubble.
    // A press on the handles is inside the node, so dragging them keeps the mode.
    const onPointerDown = (e: PointerEvent): void => { if (targetNodeId(e.target) !== id) exitNodeResize(id) }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') return exitNodeResize(id)
      // Chords (the resize shortcut itself, copy) are not typing; neither are header controls.
      if (e.metaKey || e.ctrlKey || e.altKey || MODIFIER_KEYS.has(e.key)) return
      if (targetNodeId(e.target) === id && !(e.target as Element).closest('.node-header')) exitNodeResize(id)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [editing, id])

  return <NodeResizer isVisible={editing} {...props} />
}

/** Header toggle for this node's resize mode; disabled while the view is locked. */
export function NodeResizeToggle() {
  const id = useNodeId()
  const { editingId, locked } = useNodeResizeState()
  const on = id !== null && editingId === id
  return (
    <IconButton
      size="icon-xs"
      className="nodrag node-resize-toggle"
      label={on ? 'Done resizing' : 'Resize this node'}
      commandId={RESIZE_COMMAND_ID}
      aria-pressed={on}
      disabled={locked}
      disabledReason="the view is locked"
      onClick={() => { if (id) toggleNodeResize(id) }}
    >
      <span className="codicon codicon-arrow-both" aria-hidden="true" />
    </IconButton>
  )
}

/** The "…" menu row that stands in for NodeResizeToggle when a narrow header overflows it. */
export function useNodeResizeMenuItem(): VscodeMenuItem {
  const id = useNodeId()
  const { editingId, locked } = useNodeResizeState()
  const on = id !== null && editingId === id
  // The menu sits outside the node, so its press has already ended the mode: "Done" must not toggle it back on.
  const onSelect = () => { if (!id) return; if (on) exitNodeResize(id); else toggleNodeResize(id) }
  return { type: 'item', id: 'resize', label: on ? 'Done resizing' : 'Resize this node', checked: on, disabled: locked, onSelect }
}
