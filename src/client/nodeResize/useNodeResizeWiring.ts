// Board-level wiring of resize mode: mirrors the Dock "View locked" state into the store and
// registers "Node: Resize Focused Node" in the ⌘K registry while the canvas is mounted.
import { useEffect, useMemo, type RefObject } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import { useRegisterCommands, type Command } from '../commandRegistry'
import { RESIZE_COMMAND_ID, setNodeResizeLocked, toggleFocusedNodeResize } from './nodeResize.store'

/** The resize command; `selectedIds` is read when it runs. */
export function resizeCommand(selectedIds: () => readonly string[]): Command {
  return { id: RESIZE_COMMAND_ID, label: 'Node: Resize Focused Node', defaultKey: 'Mod+Alt+R', run: () => toggleFocusedNodeResize(selectedIds()) }
}

/** Keeps resize mode in step with the view lock and registers the resize command. */
export function useNodeResizeWiring(locked: boolean, rf: RefObject<ReactFlowInstance | null>): void {
  useEffect(() => setNodeResizeLocked(locked), [locked])
  const list = useMemo(() => [resizeCommand(() => rf.current?.getNodes().filter((n) => n.selected).map((n) => n.id) ?? [])], [rf])
  useRegisterCommands(list)
}
