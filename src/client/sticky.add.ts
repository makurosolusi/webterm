// Creates a sticky note on the active board (menu, double-click on the canvas, command palette, hotkey).
import { useCallback } from 'react'
import type { RefObject } from 'react'
import type { Node, ReactFlowInstance, XYPosition } from '@xyflow/react'
import { STICKY_DEFAULT_SIZE, type StickyColorId } from '../shared/sticky.palette'
import type { Workspace, WsNode } from '../shared/workspace'
import type { Settings } from '../shared/settings'
import { randomId } from './randomId'
import { getLastStickyColor, requestStickyEdit } from './sticky.state'

type AddFlowNode = (make: (n: number, ws: Workspace) => Omit<WsNode, 'x' | 'y'>, at?: XYPosition) => void

/** Step of the diagonal offset that keeps two notes added in a row from landing exactly on top of each other. */
const STACK_STEP = 24
const STACK_CYCLE = 6

/** Offset for the next note in the stack of notes already on the board. */
export const stickyStackOffset = (existing: number): number => (existing % STACK_CYCLE) * STACK_STEP

/**
 * `addSticky(at?, color?)`: `at` is the CENTRE of the note in flow coordinates (default: the middle of the
 * view); `color` defaults to the last one picked. The note is born selected and open for typing.
 */
export function useStickyAdd(
  addFlowNode: AddFlowNode,
  rf: RefObject<ReactFlowInstance | null>,
  nodesRef: RefObject<Node[]>,
  settings: Pick<Settings, 'defaultNodeWidth' | 'defaultNodeHeight'>,
) {
  return useCallback((at?: XYPosition, color?: StickyColorId): string => {
    const id = randomId()
    const stack = stickyStackOffset(nodesRef.current.filter((n) => n.type === 'sticky').length)
    const centre = at ?? rf.current?.screenToFlowPosition({ x: window.innerWidth / 2 + stack, y: window.innerHeight / 2 + stack }) ?? { x: 160, y: 160 }
    // `addFlowNode` centres a node of the DEFAULT size on the point and the spec then shrinks it, so shift by the difference.
    const shifted = {
      x: centre.x - STICKY_DEFAULT_SIZE.width / 2 + settings.defaultNodeWidth / 2,
      y: centre.y - STICKY_DEFAULT_SIZE.height / 2 + settings.defaultNodeHeight / 2,
    }
    requestStickyEdit(id)
    addFlowNode(() => ({ id, kind: 'sticky', stickyText: '', stickyColor: color ?? getLastStickyColor(), ...STICKY_DEFAULT_SIZE }), shifted)
    return id
  }, [addFlowNode, rf, nodesRef, settings.defaultNodeWidth, settings.defaultNodeHeight])
}
