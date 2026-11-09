// Quick move & resize (Linux WM Alt+drag, macOS "Easy Move+Resize"): hold the preset keys and drag
// anywhere on a node. The middle moves it (with the selection, like a header drag), an edge or
// corner resizes it, a right-drag resizes from the nearest corner, Esc puts everything back.
//
// The gesture owns the pointer: a window capture listener runs before xterm, Monaco, the browser
// surface and React Flow, and stops the press there, so none of them selects text, opens a link or
// starts a box select. Positions and sizes reach the app through React Flow's own
// `triggerNodeChanges` with the change shapes a header drag (position + `dragging`) and NodeResizer
// (dimensions + `resizing`) emit, so autosave, layout history and snap work unchanged.
import { useEffect } from 'react'
import { useStoreApi, type InternalNode, type NodeChange } from '@xyflow/react'
import type { QuickDragPreset } from '../../shared/settings'
import { isMacPlatform } from '../terminalKeys'
import { getTabLayout } from '../tabLayout.store'
import { getNodeResizeLimits, getNodeResizeState } from '../nodeResize/nodeResize.store'
import { quickDragHeld, type ModifierState } from './quickDrag.modifier'
import { flowDelta, movedPosition, nearestCorner, resizedRect, screenRect, zoneAt, type Axes, type Rect, type Size, type Zone } from './quickDrag.geometry'
import './quickDrag.css'

const NO_KEYS: ModifierState = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }
const RIGHT_BUTTON = 2

interface Origin { id: string; rect: Rect; width?: number; height?: number; measured?: { width?: number; height?: number } }
interface Gesture {
  pointerId: number
  el: HTMLElement
  zone: Zone
  axes: Axes
  min: Size
  sx: number
  sy: number
  zoom: number
  /** The grabbed node first. */
  origins: Origin[]
  /** Last changes sent while dragging; null = the pointer has not moved yet. */
  last: NodeChange[] | null
}

const flowRect = (n: InternalNode): Rect => ({
  x: n.position.x, y: n.position.y, width: n.measured.width ?? n.width ?? 0, height: n.measured.height ?? n.height ?? 0,
})
const originOf = (n: InternalNode): Origin => ({ id: n.id, rect: flowRect(n), width: n.width, height: n.height, measured: n.internals.userNode.measured })

function paint(el: HTMLElement, zone: Zone): void {
  el.dataset.quickGrab = ''
  el.dataset.quickZone = zone
}
function unpaint(el: HTMLElement | null): void {
  if (!el) return
  delete el.dataset.quickGrab
  delete el.dataset.quickZone
}

/** Installs the gesture on the surrounding React Flow canvas; `off` installs nothing. */
export function useQuickDrag(preset: QuickDragPreset): void {
  const store = useStoreApi()
  useEffect(() => {
    if (preset === 'off') return
    const isMac = isMacPlatform()
    let gesture: Gesture | null = null
    let under: HTMLElement | null = null
    let painted: HTMLElement | null = null
    let px = 0
    let py = 0
    // The click and context menu that follow a gesture belong to it; the next press clears both.
    let swallowClick = false
    let swallowMenu = false

    const blocked = (): boolean => getTabLayout().mode === 'tabs' || getNodeResizeState().locked
    const nodeElAt = (t: EventTarget | null): HTMLElement | null => {
      const root = store.getState().domNode
      const el = t instanceof Element ? t.closest<HTMLElement>('.react-flow__node') : null
      return el && root?.contains(el) ? el : null
    }
    const zoneFor = (n: InternalNode, x: number, y: number, button: number): { zone: Zone; axes: Axes } => {
      const limits = getNodeResizeLimits(n.id)
      if (!limits) return { zone: 'move', axes: 'both' }
      const { transform, domNode } = store.getState()
      const pane = domNode?.getBoundingClientRect()
      const r = screenRect({ ...flowRect(n), ...n.internals.positionAbsolute }, transform, { x: pane?.left ?? 0, y: pane?.top ?? 0 })
      const axes: Axes = limits.collapsed ? 'x' : 'both'
      return { zone: button === RIGHT_BUTTON ? nearestCorner(x, y, r, axes) : zoneAt(x, y, r, axes), axes }
    }

    /** Grab mode on the node under the pointer while the keys are held, off otherwise. */
    const refresh = (keys: ModifierState): void => {
      if (gesture) return
      const id = under?.dataset.id
      const n = id ? store.getState().nodeLookup.get(id) : undefined
      const el = n && quickDragHeld(keys, preset, isMac) && !blocked() ? under : null
      if (painted !== el) unpaint(painted)
      painted = el
      if (el && n) paint(el, zoneFor(n, px, py, 0).zone)
    }

    const send = (changes: NodeChange[]): void => { if (changes.length) store.getState().triggerNodeChanges(changes) }

    const dragChanges = (g: Gesture, e: PointerEvent): NodeChange[] => {
      const { snapToGrid, snapGrid } = store.getState()
      const grid = snapToGrid ? snapGrid : undefined
      const { dx, dy } = flowDelta(e.clientX - g.sx, e.clientY - g.sy, g.zoom)
      const head = g.origins[0]
      if (g.zone === 'move') {
        // The grabbed node snaps; the rest keep their offsets to it (React Flow's multi-drag rule).
        const next = movedPosition(head.rect, dx, dy, grid)
        const ox = next.x - head.rect.x
        const oy = next.y - head.rect.y
        return g.origins.map((o) => ({ id: o.id, type: 'position', position: { x: o.rect.x + ox, y: o.rect.y + oy }, dragging: true }))
      }
      const r = resizedRect(head.rect, g.zone, dx, dy, g.min, grid)
      const out: NodeChange[] = []
      if (g.zone.includes('n') || g.zone.includes('w')) out.push({ id: head.id, type: 'position', position: { x: r.x, y: r.y }, dragging: true })
      out.push({
        id: head.id, type: 'dimensions', resizing: true, setAttributes: g.axes === 'x' ? 'width' : true,
        dimensions: { width: r.width, height: r.height },
      })
      return out
    }

    const finish = (keys: ModifierState): void => {
      if (!gesture) return
      const { el, pointerId } = gesture
      if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId)
      gesture = null
      swallowClick = true
      under = el
      refresh(keys)
    }

    /** Pointer up: the settled changes (dragging/resizing false), one layout history step. */
    const commit = (keys: ModifierState): void => {
      const last = gesture?.last
      if (last) {
        send(last.map((c): NodeChange => {
          if (c.type === 'position') return { ...c, dragging: false }
          if (c.type === 'dimensions') return { id: c.id, type: 'dimensions', resizing: false, dimensions: c.dimensions }
          return c
        }))
      }
      finish(keys)
    }

    /** Esc / pointer cancel: one `replace` per node back to its start (saved, not a history step). */
    const cancel = (keys: ModifierState): void => {
      const g = gesture
      if (g?.last) {
        const { nodeLookup } = store.getState()
        send(g.origins.flatMap((o): NodeChange[] => {
          const user = nodeLookup.get(o.id)?.internals.userNode
          if (!user) return []
          const item = { ...user, position: { x: o.rect.x, y: o.rect.y }, width: o.width, height: o.height, measured: o.measured, dragging: false, resizing: false }
          return [{ id: o.id, type: 'replace', item }]
        }))
      }
      finish(keys)
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (gesture) { e.preventDefault(); e.stopPropagation(); return }
      swallowClick = false
      swallowMenu = false
      if (!quickDragHeld(e, preset, isMac) || (e.button !== 0 && e.button !== RIGHT_BUTTON) || blocked()) return
      const el = nodeElAt(e.target)
      const s = store.getState()
      const node = el?.dataset.id ? s.nodeLookup.get(el.dataset.id) : undefined
      if (!el || !node) return
      e.preventDefault()
      e.stopPropagation()
      swallowMenu = true
      const { zone, axes } = zoneFor(node, e.clientX, e.clientY, e.button)
      let ids = [node.id]
      if (zone === 'move') {
        // Same rule as a header drag: a selected node carries the selection, another is selected alone.
        if (node.selected) ids = [node.id, ...s.nodes.filter((n) => n.selected && n.id !== node.id).map((n) => n.id)]
        else s.addSelectedNodes([node.id])
      }
      const limits = getNodeResizeLimits(node.id)
      gesture = {
        pointerId: e.pointerId, el, zone, axes, sx: e.clientX, sy: e.clientY, zoom: s.transform[2], last: null,
        min: { width: limits?.minWidth ?? 0, height: limits?.minHeight ?? 0 },
        origins: ids.flatMap((id) => { const n = s.nodeLookup.get(id); return n ? [originOf(n)] : [] }),
      }
      el.setPointerCapture?.(e.pointerId)
      if (painted !== el) unpaint(painted)
      painted = el
      paint(el, zone)
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (gesture) {
        if (e.pointerId !== gesture.pointerId) return
        e.preventDefault()
        e.stopPropagation()
        gesture.last = dragChanges(gesture, e)
        send(gesture.last)
        return
      }
      under = nodeElAt(e.target)
      px = e.clientX
      py = e.clientY
      refresh(e)
    }

    const onPointerEnd = (e: PointerEvent): void => {
      if (!gesture || e.pointerId !== gesture.pointerId) return
      e.preventDefault()
      e.stopPropagation()
      if (e.type === 'pointercancel') cancel(e)
      else commit(e)
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (gesture) {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        cancel(e)
        return
      }
      swallowMenu = false
      refresh(e)
    }
    const onKeyUp = (e: KeyboardEvent): void => refresh(e)
    const onBlur = (): void => { under = null; refresh(NO_KEYS) }
    const swallow = (e: MouseEvent, flag: 'click' | 'menu'): void => {
      // `detail` 0 = a keyboard/synthetic click (Enter on a button): never the gesture's own click.
      const on = flag === 'click' ? swallowClick && e.detail > 0 : swallowMenu || gesture !== null
      if (!on) return
      e.preventDefault()
      e.stopPropagation()
      if (flag === 'click') swallowClick = false
      else if (!gesture) swallowMenu = false
    }
    const onClick = (e: MouseEvent): void => swallow(e, 'click')
    const onMenu = (e: MouseEvent): void => swallow(e, 'menu')

    const listeners: [string, EventListener][] = [
      ['pointerdown', onPointerDown as EventListener], ['pointermove', onPointerMove as EventListener],
      ['pointerup', onPointerEnd as EventListener], ['pointercancel', onPointerEnd as EventListener],
      ['keydown', onKeyDown as EventListener], ['keyup', onKeyUp as EventListener],
      ['click', onClick as EventListener], ['contextmenu', onMenu as EventListener],
    ]
    for (const [type, fn] of listeners) window.addEventListener(type, fn, true)
    window.addEventListener('blur', onBlur)
    return () => {
      for (const [type, fn] of listeners) window.removeEventListener(type, fn, true)
      window.removeEventListener('blur', onBlur)
      unpaint(painted)
      gesture = null
    }
  }, [preset, store])
}

/** Mount point inside `<ReactFlow>` (the hook needs its store). */
export function QuickDrag({ preset }: { preset: QuickDragPreset }): null {
  useQuickDrag(preset)
  return null
}
