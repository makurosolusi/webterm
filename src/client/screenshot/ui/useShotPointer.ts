// Pointer gestures of the overlay over one surface: drag a new selection, move or resize it by a handle,
// and draw a shape with the active tool. Pointer Events + capture, so mouse, touch and pen behave the same.
// Updates are coalesced to one dispatch per animation frame; the last one is flushed on release.
import { useCallback, useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent } from 'react'
import { dragRect, hitHandle, insideRect, moveRect, resizeRect } from '../shot.selection'
import type { Handle, Point, Rect, Shape, Tool } from '../shot.types'
import { cursorFor, toImage } from './shot.ui.layout'
import type { UiAction, UiState } from './shot.ui.machine'

/** How close (CSS px) to a handle a press counts as grabbing it. */
export const HANDLE_HIT_PX = 10

type Drag =
  | { k: 'new'; from: Point }
  | { k: 'move'; last: Point }
  | { k: 'resize'; handle: Handle }
  | { k: 'shape'; tool: Exclude<Tool, 'text'>; from: Point; points: Point[] }

const clampPoint = (p: Point, w: number, h: number): Point => ({ x: Math.min(w, Math.max(0, p.x)), y: Math.min(h, Math.max(0, p.y)) })

function shapeOf(d: Extract<Drag, { k: 'shape' }>, to: Point, s: Pick<UiState, 'color' | 'width'>): Shape {
  const style = { color: s.color, width: s.width }
  if (d.tool === 'pen' || d.tool === 'marker') return { kind: d.tool, ...style, points: d.points }
  return { kind: d.tool, ...style, from: d.from, to }
}

export interface PointerArgs {
  state: UiState
  dispatch: Dispatch<UiAction>
  /** Called with the image point where the text tool was pressed. */
  onText: (p: Point) => void
}

export function useShotPointer({ state, dispatch, onText }: PointerArgs) {
  const stateRef = useRef(state)
  stateRef.current = state
  const drag = useRef<Drag | null>(null)
  const live = useRef<{ selection?: Rect; draft?: Shape | null }>({})
  const frameId = useRef(0)
  const [draft, setDraft] = useState<Shape | null>(null)

  const flush = useCallback(() => {
    cancelAnimationFrame(frameId.current)
    frameId.current = 0
    const l = live.current
    live.current = {}
    if (l.selection) dispatch({ type: stateRef.current.phase === 'selecting' ? 'dragSelection' : 'setSelection', rect: l.selection })
    if (l.draft !== undefined) setDraft(l.draft)
  }, [dispatch])
  const schedule = useCallback(() => { if (!frameId.current) frameId.current = requestAnimationFrame(flush) }, [flush])
  useEffect(() => () => cancelAnimationFrame(frameId.current), [])

  const imagePoint = (e: ReactPointerEvent<HTMLElement>): Point => {
    const box = e.currentTarget.getBoundingClientRect()
    return toImage({ x: e.clientX - box.left, y: e.clientY - box.top }, stateRef.current.scale)
  }
  const bounds = () => ({ w: stateRef.current.frame?.width ?? 0, h: stateRef.current.frame?.height ?? 0 })
  /** The selection as last computed this gesture (before the reducer has it). */
  const currentSel = (): Rect | null => live.current.selection ?? stateRef.current.selection

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || !e.isPrimary) return
    const s = stateRef.current
    const p = imagePoint(e)
    const tol = HANDLE_HIT_PX * s.scale
    let next: Drag | null = null
    if (s.phase === 'selecting') next = { k: 'new', from: clampPoint(p, bounds().w, bounds().h) }
    else if (s.phase === 'selected' && s.selection) {
      const handle = hitHandle(s.selection, p, tol)
      if (handle) next = { k: 'resize', handle }
      else if (insideRect(s.selection, p)) {
        if (s.tool === 'text') { onText(p); return }
        next = s.tool ? { k: 'shape', tool: s.tool, from: clampPoint(p, bounds().w, bounds().h), points: [clampPoint(p, bounds().w, bounds().h)] } : { k: 'move', last: p }
      }
    }
    if (!next) return
    drag.current = next
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const s = stateRef.current
    const p = imagePoint(e)
    const d = drag.current
    if (!d) {
      const sel = s.selection
      const hit = { handle: sel && s.phase === 'selected' ? hitHandle(sel, p, HANDLE_HIT_PX * s.scale) : null, inside: !!sel && insideRect(sel, p) }
      e.currentTarget.style.cursor = cursorFor(hit, s.tool, s.phase === 'selecting')
      return
    }
    const { w, h } = bounds()
    if (d.k === 'new') live.current.selection = dragRect(d.from, p, { w, h })
    else if (d.k === 'move') {
      const sel = currentSel()
      if (sel) live.current.selection = moveRect(sel, p.x - d.last.x, p.y - d.last.y, { w, h })
      d.last = p
    } else if (d.k === 'resize') {
      const sel = currentSel()
      if (sel) live.current.selection = resizeRect(sel, d.handle, p, { w, h })
    } else {
      const q = clampPoint(p, w, h)
      if (d.tool === 'pen' || d.tool === 'marker') d.points = [...d.points, q]
      live.current.draft = shapeOf(d, q, s)
    }
    schedule()
  }

  /** Drop pending frame work: the gesture is over and its result is decided here. */
  const settle = (): void => {
    live.current = {}
    cancelAnimationFrame(frameId.current)
    frameId.current = 0
  }

  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    const { w, h } = bounds()
    if (d.k === 'shape') {
      const shape = shapeOf(d, clampPoint(imagePoint(e), w, h), stateRef.current)
      settle()
      setDraft(null)
      if (!cancelled) dispatch({ type: 'addShape', shape })
    } else if (d.k === 'new') {
      // A cancelled drag commits an empty rectangle, which the machine rejects: no half selection survives.
      const rect = cancelled ? { x: 0, y: 0, w: 0, h: 0 } : dragRect(d.from, imagePoint(e), { w, h })
      settle()
      dispatch({ type: 'commitSelection', rect })
    } else flush()
  }

  return {
    draft,
    surfaceProps: {
      onPointerDown, onPointerMove,
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => finish(e, false),
      onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => finish(e, true),
    },
  }
}
