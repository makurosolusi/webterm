/** @vitest-environment jsdom */
import { afterEach, describe, expect, test } from 'vitest'
import { nudgeSelection } from './ShotSelection'
import { BAR_SIZE, RAIL_SIZE, VIEWPORT_MARGIN_PX, cursorFor, labelFitsAbove, placeBar, placeRail, popoverSide, toCss, toImage } from './shot.ui.layout'
import { keyIntent } from './shot.ui.keys'
import { loadPrefs, savePrefs } from './shot.ui.prefs'
import { SHOT_COLORS } from '../shot.palette'
import { registerCommands } from '@/commandRegistry'

const vp = { w: 1000, h: 700 }
const inside = (p: { x: number; y: number }, s: { w: number; h: number }): boolean =>
  p.x >= VIEWPORT_MARGIN_PX && p.y >= VIEWPORT_MARGIN_PX && p.x + s.w <= vp.w - VIEWPORT_MARGIN_PX && p.y + s.h <= vp.h - VIEWPORT_MARGIN_PX

describe('placement', () => {
  test('rail sits right of the selection, top-aligned', () => {
    const r = placeRail({ x: 100, y: 100, w: 300, h: 300 }, vp)
    expect(r).toMatchObject({ side: 'right', x: 408, y: 100 })
  })
  test('rail flips left when the right side does not fit, inside when neither fits', () => {
    expect(placeRail({ x: 400, y: 100, w: 580, h: 300 }, vp).side).toBe('left')
    const full = placeRail({ x: 0, y: 0, w: 1000, h: 700 }, vp)
    expect(full.side).toBe('inside')
    expect(inside(full, RAIL_SIZE)).toBe(true)
  })
  test('rail and bar stay inside the viewport for selections at every edge', () => {
    for (const sel of [{ x: 0, y: 0, w: 20, h: 20 }, { x: 980, y: 680, w: 20, h: 20 }, { x: 0, y: 650, w: 1000, h: 50 }, { x: 500, y: 0, w: 500, h: 700 }]) {
      expect(inside(placeRail(sel, vp), RAIL_SIZE)).toBe(true)
      expect(inside(placeBar(sel, vp), BAR_SIZE)).toBe(true)
    }
  })
  test('bar sits under the selection, right-aligned, and moves up inside it at the bottom edge', () => {
    expect(placeBar({ x: 100, y: 100, w: 300, h: 200 }, vp)).toEqual({ x: 400 - BAR_SIZE.w, y: 308 })
    const low = placeBar({ x: 100, y: 300, w: 300, h: 400 }, vp)
    expect(low.y).toBeLessThan(700 - BAR_SIZE.h)
    expect(low.y).toBeGreaterThanOrEqual(300)
  })
  test('popover opens toward the middle of the screen', () => {
    expect(popoverSide(600, 1000)).toBe('left')
    expect(popoverSide(5, 1000)).toBe('right')
  })
  test('size label moves inside the selection at the top edge', () => {
    expect(labelFitsAbove({ x: 0, y: 40, w: 10, h: 10 })).toBe(true)
    expect(labelFitsAbove({ x: 0, y: 5, w: 10, h: 10 })).toBe(false)
  })
  test('css <-> image conversion round-trips', () => {
    expect(toCss({ x: 200, y: 100, w: 400, h: 300 }, 2)).toEqual({ x: 100, y: 50, w: 200, h: 150 })
    expect(toImage({ x: 10, y: 20 }, 2)).toEqual({ x: 20, y: 40 })
  })
  test('cursor: crosshair while selecting, resize on handles, move inside, tool cursor with a tool', () => {
    expect(cursorFor({ handle: null, inside: false }, null, true)).toBe('crosshair')
    expect(cursorFor({ handle: 'nw', inside: true }, null, false)).toBe('nwse-resize')
    expect(cursorFor({ handle: null, inside: true }, null, false)).toBe('move')
    expect(cursorFor({ handle: null, inside: true }, 'pen', false)).toBe('crosshair')
    expect(cursorFor({ handle: null, inside: true }, 'text', false)).toBe('text')
  })
})

describe('keyboard selection', () => {
  const sel = { x: 100, y: 100, w: 200, h: 100 }
  const b = { w: 1000, h: 700 }
  test('arrows move, Shift+arrows resize, other keys are ignored', () => {
    expect(nudgeSelection(sel, 'ArrowRight', false, b)).toEqual({ x: 110, y: 100, w: 200, h: 100 })
    expect(nudgeSelection(sel, 'ArrowRight', true, b)).toEqual({ x: 100, y: 100, w: 210, h: 100 })
    expect(nudgeSelection(sel, 'ArrowUp', true, b)).toEqual({ x: 100, y: 90, w: 200, h: 110 })
    expect(nudgeSelection(sel, 'a', false, b)).toBeNull()
  })
})

describe('key intents', () => {
  const k = (init: Partial<KeyboardEventInit> & { key: string; code?: string }) => ({ key: init.key, code: init.code ?? '', metaKey: !!init.metaKey, ctrlKey: !!init.ctrlKey, altKey: !!init.altKey, shiftKey: !!init.shiftKey })
  const field = Object.assign(document.createElement('textarea'), {})
  const button = document.createElement('button')
  test('Escape, Enter, undo, redo, copy and save (Mod = Cmd on macOS)', () => {
    expect(keyIntent(k({ key: 'Escape' }), null, true)).toBe('close')
    expect(keyIntent(k({ key: 'Enter' }), null, true)).toBe('selectAll')
    expect(keyIntent(k({ key: 'z', code: 'KeyZ', metaKey: true }), null, true)).toBe('undo')
    expect(keyIntent(k({ key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true }), null, true)).toBe('redo')
    expect(keyIntent(k({ key: 'c', code: 'KeyC', ctrlKey: true }), null, false)).toBe('copy')
    expect(keyIntent(k({ key: 's', code: 'KeyS', ctrlKey: true }), null, false)).toBe('save')
  })
  test('inside the text field undo/copy/Enter stay text edits, save still works', () => {
    expect(keyIntent(k({ key: 'z', code: 'KeyZ', metaKey: true }), field, true)).toBeNull()
    expect(keyIntent(k({ key: 'c', code: 'KeyC', metaKey: true }), field, true)).toBeNull()
    expect(keyIntent(k({ key: 'Enter' }), field, true)).toBeNull()
    expect(keyIntent(k({ key: 's', code: 'KeyS', metaKey: true }), field, true)).toBe('save')
  })
  test('Enter on a focused button activates it instead of selecting all', () => {
    expect(keyIntent(k({ key: 'Enter' }), button, true)).toBeNull()
  })
  test('the screenshot command chord (as bound) toggles closed', () => {
    const off = registerCommands([{ id: 'canvas.screenshot', label: 'Canvas: Take Screenshot', defaultKey: 'Mod+Shift+S', run: () => {} }])
    expect(keyIntent(k({ key: 'S', code: 'KeyS', metaKey: true, shiftKey: true }), null, true)).toBe('close')
    off()
  })
})

describe('prefs', () => {
  afterEach(() => localStorage.clear())
  test('round-trips presets and drops anything that is not a preset', () => {
    savePrefs({ color: SHOT_COLORS[4].value, width: 8, textSize: 36 })
    expect(loadPrefs()).toEqual({ color: SHOT_COLORS[4].value, width: 8, textSize: 36 })
    localStorage.setItem('webterm.screenshot.prefs', JSON.stringify({ color: 'javascript:1', width: 99, textSize: 'x' }))
    expect(loadPrefs()).toEqual({})
    localStorage.setItem('webterm.screenshot.prefs', '{broken')
    expect(loadPrefs()).toEqual({})
  })
  test('a throwing storage never breaks the overlay', () => {
    const real = Storage.prototype.getItem
    Storage.prototype.getItem = () => { throw new Error('blocked') }
    try { expect(loadPrefs()).toEqual({}) } finally { Storage.prototype.getItem = real }
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw new Error('quota') }
    try { expect(() => savePrefs({ color: SHOT_COLORS[0].value, width: 4, textSize: 24 })).not.toThrow() } finally { Storage.prototype.setItem = set }
  })
})
