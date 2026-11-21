/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useReducer } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ShotFrame } from '../shot.render'
import { initialState, shotReducer, type UiAction, type UiState } from './shot.ui.machine'
import { useShotPointer } from './useShotPointer'

const frame = { width: 2000, height: 1200 } as ShotFrame
let latest: UiState
let draft: unknown
const texts: unknown[] = []

// scale 2: 1 CSS px = 2 image px; jsdom boxes are 0,0 so client coords are surface coords.
function Harness({ seed }: { seed: UiAction[] }) {
  const [state, dispatch] = useReducer(shotReducer, seed.reduce(shotReducer, initialState()))
  latest = state
  const p = useShotPointer({ state, dispatch, onText: (pt) => texts.push(pt) })
  draft = p.draft
  return <div data-testid="s" {...p.surfaceProps} />
}

const open: UiAction[] = [{ type: 'start' }, { type: 'captured', frame, css: { w: 1000, h: 600 }, scale: 2 }]
const selected: UiAction[] = [...open, { type: 'commitSelection', rect: { x: 200, y: 200, w: 400, h: 300 } }]
const ev = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, isPrimary: true, pointerId: 1 })
const surface = () => screen.getByTestId('s')
const drag = (from: [number, number], to: [number, number]) => {
  fireEvent.pointerDown(surface(), ev(...from))
  fireEvent.pointerMove(surface(), ev(...to))
  fireEvent.pointerUp(surface(), ev(...to))
}

beforeEach(() => {
  texts.length = 0
  // Run animation frames at once so coalesced updates are observable synchronously.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('selecting', () => {
  test('dragging in any direction commits a selection in image pixels', () => {
    render(<Harness seed={open} />)
    drag([300, 250], [100, 50]) // up-left
    expect(latest.phase).toBe('selected')
    expect(latest.selection).toEqual({ x: 200, y: 100, w: 400, h: 400 })
  })

  test('the live rectangle follows the pointer before release', () => {
    render(<Harness seed={open} />)
    fireEvent.pointerDown(surface(), ev(10, 10))
    fireEvent.pointerMove(surface(), ev(60, 40))
    expect(latest.phase).toBe('selecting')
    expect(latest.selection).toEqual({ x: 20, y: 20, w: 100, h: 60 })
    fireEvent.pointerUp(surface(), ev(60, 40))
    expect(latest.phase).toBe('selected')
  })

  test('a tiny drag or a plain click is dropped (minimum size)', () => {
    render(<Harness seed={open} />)
    drag([100, 100], [102, 102])
    expect(latest.phase).toBe('selecting')
    expect(latest.selection).toBeNull()
  })

  test('the selection is clamped to the image', () => {
    render(<Harness seed={open} />)
    drag([900, 500], [5000, 5000])
    expect(latest.selection).toEqual({ x: 1800, y: 1000, w: 200, h: 200 })
  })

  test('cancel (pointercancel) never leaves a half selection', () => {
    render(<Harness seed={open} />)
    fireEvent.pointerDown(surface(), ev(10, 10))
    fireEvent.pointerMove(surface(), ev(5, 5))
    fireEvent.pointerCancel(surface(), ev(5, 5))
    expect(latest.phase).toBe('selecting')
    expect(latest.selection).toBeNull()
  })

  test('only the primary button starts a gesture', () => {
    render(<Harness seed={open} />)
    fireEvent.pointerDown(surface(), { ...ev(10, 10), button: 2 })
    fireEvent.pointerMove(surface(), ev(200, 200))
    fireEvent.pointerUp(surface(), ev(200, 200))
    expect(latest.selection).toBeNull()
  })
})

describe('selected: move and resize', () => {
  test('drag inside moves it, stopped at the image edge', () => {
    render(<Harness seed={selected} />)
    drag([200, 200], [250, 220]) // +50,+20 css = +100,+40 image
    expect(latest.selection).toEqual({ x: 300, y: 240, w: 400, h: 300 })
    drag([250, 220], [2000, 2000])
    expect(latest.selection).toEqual({ x: 1600, y: 900, w: 400, h: 300 })
  })

  test('a handle resizes and the cursor shows the resize arrow on hover', () => {
    render(<Harness seed={selected} />)
    fireEvent.pointerMove(surface(), ev(300, 250)) // se corner: image (600,500)
    expect(surface().style.cursor).toBe('nwse-resize')
    drag([300, 250], [400, 300]) // se corner to image (800,600)
    expect(latest.selection).toEqual({ x: 200, y: 200, w: 600, h: 400 })
  })

  test('dragging a handle past the opposite edge flips the rectangle', () => {
    render(<Harness seed={selected} />)
    drag([300, 250], [50, 50]) // se corner to image (100,100): left of and above the origin
    expect(latest.selection!.x).toBeLessThan(200)
    expect(latest.selection!.w).toBeGreaterThanOrEqual(8)
  })

  test('hover cursors: move inside, crosshair outside', () => {
    render(<Harness seed={selected} />)
    fireEvent.pointerMove(surface(), ev(250, 200))
    expect(surface().style.cursor).toBe('move')
    fireEvent.pointerMove(surface(), ev(900, 500))
    expect(surface().style.cursor).toBe('crosshair')
  })

  test('a press outside the selection does nothing', () => {
    render(<Harness seed={selected} />)
    drag([900, 500], [950, 550])
    expect(latest.selection).toEqual({ x: 200, y: 200, w: 400, h: 300 })
  })
})

describe('drawing', () => {
  const withTool = (tool: 'pen' | 'rect' | 'text'): UiAction[] => [...selected, { type: 'setTool', tool }]

  test('rect shows a draft while dragging and commits one shape on release', () => {
    render(<Harness seed={withTool('rect')} />)
    fireEvent.pointerDown(surface(), ev(150, 150))
    fireEvent.pointerMove(surface(), ev(200, 200))
    expect(draft).toMatchObject({ kind: 'rect', from: { x: 300, y: 300 }, to: { x: 400, y: 400 } })
    expect(latest.shots.shapes).toHaveLength(0)
    fireEvent.pointerUp(surface(), ev(200, 200))
    expect(draft).toBeNull()
    expect(latest.shots.shapes).toMatchObject([{ kind: 'rect', color: latest.color, width: latest.width }])
  })

  test('pen collects the points of the path', () => {
    render(<Harness seed={withTool('pen')} />)
    fireEvent.pointerDown(surface(), ev(150, 150))
    fireEvent.pointerMove(surface(), ev(160, 160))
    fireEvent.pointerMove(surface(), ev(170, 150))
    fireEvent.pointerUp(surface(), ev(170, 150))
    expect(latest.shots.shapes).toHaveLength(1)
    expect((latest.shots.shapes[0] as { points: unknown[] }).points.length).toBeGreaterThanOrEqual(3)
  })

  test('a click without movement draws no rect (the model drops it)', () => {
    render(<Harness seed={withTool('rect')} />)
    drag([150, 150], [150, 150])
    expect(latest.shots.shapes).toHaveLength(0)
  })

  test('a cancelled drawing leaves no shape', () => {
    render(<Harness seed={withTool('rect')} />)
    fireEvent.pointerDown(surface(), ev(150, 150))
    fireEvent.pointerMove(surface(), ev(220, 220))
    fireEvent.pointerCancel(surface(), ev(220, 220))
    expect(latest.shots.shapes).toHaveLength(0)
    expect(draft).toBeNull()
  })

  test('the text tool reports the clicked image point instead of drawing', () => {
    render(<Harness seed={withTool('text')} />)
    act(() => { fireEvent.pointerDown(surface(), ev(150, 150)) })
    expect(texts).toEqual([{ x: 300, y: 300 }])
  })

  test('with a tool, a press on a handle still resizes (the frame stays adjustable)', () => {
    render(<Harness seed={withTool('rect')} />)
    drag([300, 250], [400, 300])
    expect(latest.selection).toEqual({ x: 200, y: 200, w: 600, h: 400 })
    expect(latest.shots.shapes).toHaveLength(0)
  })
})
