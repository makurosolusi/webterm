/** @vitest-environment jsdom */
// Quick move & resize on the REAL canvas (App + React Flow): the changes must reach the app's
// `onNodesChange` (rendered position/size, layout history), and the press must never reach the
// node content underneath.
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installCanvasDom, mountCanvas, unmountCanvas } from '../canvasHarness'
import { isMacPlatform } from '../terminalKeys'
import { setMode } from '../tabLayout.store'
import { setNodeResizeLocked } from '../nodeResize/nodeResize.store'
import type { WsNode } from '../../shared/workspace'

// test-only fixtures: two terminals side by side, identity viewport (screen px = flow units).
const t1: WsNode = { id: 't1', kind: 'terminal', x: 0, y: 0, width: 420, height: 320, cwd: '/', title: 'one' }
const t2: WsNode = { id: 't2', kind: 'terminal', x: 600, y: 0, width: 420, height: 320, cwd: '/', title: 'two' }

beforeAll(installCanvasDom)
afterEach(() => { setMode('canvas'); setNodeResizeLocked(false); unmountCanvas() })

/** The default preset (⌘⌃ on macOS, Ctrl+Alt elsewhere) as event init. */
const MODS = isMacPlatform() ? { metaKey: true, ctrlKey: true } : { ctrlKey: true, altKey: true }
const nodeEl = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
  if (!el) throw new Error(`node ${id} not rendered`)
  return el
}
/** Deepest content element of a node: what a press over the terminal actually hits. */
const contentOf = (id: string): HTMLElement => {
  let el = nodeEl(id).querySelector<HTMLElement>('.xterm, .node-body') ?? nodeEl(id)
  while (el.firstElementChild instanceof HTMLElement) el = el.firstElementChild
  return el
}
const posOf = (id: string): { x: number; y: number } => {
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(nodeEl(id).style.transform)
  if (!m) throw new Error(`node ${id} has no position`)
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) }
}
const sizeOf = (id: string) => ({ width: parseFloat(nodeEl(id).style.width), height: parseFloat(nodeEl(id).style.height) })
const undo = () => {
  const btn = document.querySelector<HTMLElement>('[aria-label="Undo"]')
  if (!btn) throw new Error('Undo button not rendered')
  act(() => { fireEvent.click(btn) })
}

type Pt = [number, number]
const ev = (x: number, y: number, extra: object) => ({ clientX: x, clientY: y, pointerId: 1, bubbles: true, cancelable: true, ...extra })
function press(target: Element, [x, y]: Pt, extra: object = MODS) {
  return fireEvent.pointerDown(target, ev(x, y, { button: 0, ...extra }))
}
function moveTo([x, y]: Pt, extra: object = MODS) { act(() => { fireEvent.pointerMove(window, ev(x, y, extra)) }) }
function release([x, y]: Pt, extra: object = MODS) { act(() => { fireEvent.pointerUp(window, ev(x, y, extra)) }) }
function drag(target: Element, from: Pt, to: Pt, extra: object = MODS) {
  act(() => { press(target, from, extra) })
  moveTo(to, extra)
  release(to, extra)
}

describe('quick move & resize (canvas)', () => {
  it('modifier + drag in the middle moves and selects only that node; one undo step', async () => {
    await mountCanvas({ nodes: [t1, t2], dirs: {} })
    drag(contentOf('t1'), [210, 160], [260, 190])
    await waitFor(() => expect(posOf('t1')).toEqual({ x: 50, y: 30 }))
    expect(posOf('t2')).toEqual({ x: 600, y: 0 })
    expect(nodeEl('t1').classList.contains('selected')).toBe(true)
    expect(nodeEl('t2').classList.contains('selected')).toBe(false)
    undo()
    await waitFor(() => expect(posOf('t1')).toEqual({ x: 0, y: 0 }))
  })

  it('modifier + drag on the bottom-right corner grows the node, anchor stays put', async () => {
    await mountCanvas({ nodes: [t1], dirs: {} })
    drag(contentOf('t1'), [418, 318], [468, 358])
    await waitFor(() => expect(sizeOf('t1')).toEqual({ width: 470, height: 360 }))
    expect(posOf('t1')).toEqual({ x: 0, y: 0 })
  })

  it('resize respects the terminal min size (240×160) from the top-left corner', async () => {
    await mountCanvas({ nodes: [t1], dirs: {} })
    drag(contentOf('t1'), [2, 2], [400, 300])
    await waitFor(() => expect(sizeOf('t1')).toEqual({ width: 240, height: 160 }))
    expect(posOf('t1')).toEqual({ x: 180, y: 160 })
  })

  it('right-drag resizes from the nearest corner and suppresses that context menu', async () => {
    await mountCanvas({ nodes: [t1], dirs: {} })
    act(() => { press(contentOf('t1'), [300, 200], { ...MODS, button: 2 }) })
    moveTo([340, 240])
    release([340, 240])
    act(() => { fireEvent.contextMenu(contentOf('t1'), { ...MODS, button: 2, clientX: 340, clientY: 240 }) })
    await waitFor(() => expect(sizeOf('t1')).toEqual({ width: 460, height: 360 }))
    expect(screen.queryByRole('menu')).toBeNull()
    // The next press is not part of the gesture: the node's own menu opens as usual.
    act(() => { fireEvent.pointerDown(contentOf('t1'), ev(10, 10, { button: 2 })) })
    act(() => { fireEvent.contextMenu(contentOf('t1'), { button: 2, clientX: 10, clientY: 10 }) })
    expect(screen.queryByRole('menu')).not.toBeNull()
  })

  it('Esc during the drag restores position and size without a history step', async () => {
    await mountCanvas({ nodes: [t1], dirs: {} })
    // One committed move first: the single Undo at the end must land on the start, which it only
    // does if the cancelled gestures left no history steps of their own.
    drag(contentOf('t1'), [210, 160], [220, 170])
    await waitFor(() => expect(posOf('t1')).toEqual({ x: 10, y: 10 }))

    act(() => { press(contentOf('t1'), [220, 170]) })
    moveTo([300, 260])
    await waitFor(() => expect(posOf('t1')).toEqual({ x: 90, y: 100 }))
    act(() => { fireEvent.keyDown(window, { key: 'Escape', ...MODS }) })
    await waitFor(() => expect(posOf('t1')).toEqual({ x: 10, y: 10 }))
    release([300, 260])
    expect(posOf('t1')).toEqual({ x: 10, y: 10 })

    act(() => { press(contentOf('t1'), [428, 328]) })
    moveTo([510, 410])
    await waitFor(() => expect(sizeOf('t1')).toEqual({ width: 502, height: 402 }))
    act(() => { fireEvent.keyDown(window, { key: 'Escape', ...MODS }) })
    await waitFor(() => expect(sizeOf('t1')).toEqual({ width: 420, height: 320 }))
    expect(posOf('t1')).toEqual({ x: 10, y: 10 })

    undo()
    await waitFor(() => expect(posOf('t1')).toEqual({ x: 0, y: 0 }))
  })

  it('a multi-selection moves together', async () => {
    await mountCanvas({ nodes: [t1, t2], dirs: {} })
    fireEvent.contextMenu(document.querySelector('.react-flow__pane')!, { clientX: 1200, clientY: 700 })
    fireEvent.click(await screen.findByText('Select All'))
    await waitFor(() => expect(nodeEl('t2').classList.contains('selected')).toBe(true))
    drag(contentOf('t1'), [210, 160], [230, 200])
    await waitFor(() => expect(posOf('t1')).toEqual({ x: 20, y: 40 }))
    expect(posOf('t2')).toEqual({ x: 620, y: 40 })
  })

  it('holding the keys shows grab mode per zone; releasing them clears it', async () => {
    await mountCanvas({ nodes: [t1], dirs: {} })
    act(() => { fireEvent.pointerMove(contentOf('t1'), ev(210, 160, MODS)) })
    expect(nodeEl('t1').dataset.quickZone).toBe('move')
    expect(nodeEl('t1').hasAttribute('data-quick-grab')).toBe(true)
    act(() => { fireEvent.pointerMove(contentOf('t1'), ev(418, 160, MODS)) })
    expect(nodeEl('t1').dataset.quickZone).toBe('e')
    act(() => { fireEvent.keyUp(window, { key: 'Control' }) })
    expect(nodeEl('t1').hasAttribute('data-quick-grab')).toBe(false)
  })

  it('policy: a modifier press inside node content is stopped before the content sees it', async () => {
    await mountCanvas({ nodes: [t1], dirs: {} })
    const seen: string[] = []
    const inner = contentOf('t1')
    inner.addEventListener('pointerdown', () => seen.push('inner'))
    nodeEl('t1').addEventListener('pointerdown', () => seen.push('node'), true)
    let notPrevented = true
    act(() => { notPrevented = press(inner, [210, 160]) })
    release([210, 160])
    expect(seen).toEqual([])
    expect(notPrevented).toBe(false)
    // The click that ends the gesture is swallowed (a link under it must not open); it is one-shot.
    expect(fireEvent.click(inner, { detail: 1 })).toBe(false)
    expect(fireEvent.click(inner, { detail: 1 })).toBe(true)
  })

  it('a plain drag (no modifier) over terminal content does nothing new', async () => {
    await mountCanvas({ nodes: [t1], dirs: {} })
    const seen: string[] = []
    contentOf('t1').addEventListener('pointerdown', () => seen.push('inner'))
    drag(contentOf('t1'), [210, 160], [300, 260], {})
    expect(seen).toEqual(['inner'])
    expect(posOf('t1')).toEqual({ x: 0, y: 0 })
    expect(nodeEl('t1').hasAttribute('data-quick-grab')).toBe(false)
  })

  it('tab layout mode and the view lock are no-ops', async () => {
    await mountCanvas({ nodes: [t1], dirs: {} })
    act(() => setNodeResizeLocked(true))
    drag(contentOf('t1'), [210, 160], [300, 260])
    expect(posOf('t1')).toEqual({ x: 0, y: 0 })
    act(() => setNodeResizeLocked(false))
    act(() => setMode('tabs'))
    const seen: string[] = []
    contentOf('t1').addEventListener('pointerdown', () => seen.push('inner'))
    drag(contentOf('t1'), [210, 160], [300, 260])
    expect(seen).toEqual(['inner'])
    expect(posOf('t1')).toEqual({ x: 0, y: 0 })
  })

  it('preset Off installs nothing', async () => {
    await mountCanvas({ nodes: [t1], dirs: {}, settings: { quickDrag: 'off' } })
    drag(contentOf('t1'), [210, 160], [300, 260])
    expect(posOf('t1')).toEqual({ x: 0, y: 0 })
  })
})
