/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { QUICK_DRAG_PRESETS } from '../../shared/settings'
import { quickDragHeld, quickDragLabel, type ModifierState } from './quickDrag.modifier'

const keys = (k: Partial<ModifierState>): ModifierState => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...k })
const ALL: Record<string, ModifierState> = {
  none: keys({}), cmdCtrl: keys({ metaKey: true, ctrlKey: true }), cmdShift: keys({ metaKey: true, shiftKey: true }),
  ctrlAlt: keys({ ctrlKey: true, altKey: true }), ctrlShift: keys({ ctrlKey: true, shiftKey: true }),
  cmd: keys({ metaKey: true }), ctrl: keys({ ctrlKey: true }), alt: keys({ altKey: true }),
  cmdCtrlShift: keys({ metaKey: true, ctrlKey: true, shiftKey: true }), ctrlAltShift: keys({ ctrlKey: true, altKey: true, shiftKey: true }),
}
const matching = (preset: (typeof QUICK_DRAG_PRESETS)[number], isMac: boolean) =>
  Object.entries(ALL).filter(([, k]) => quickDragHeld(k, preset, isMac)).map(([name]) => name)

describe('quickDragHeld', () => {
  it('each preset matches exactly its chord per platform', () => {
    expect(matching('cmdCtrl', true)).toEqual(['cmdCtrl'])
    expect(matching('cmdCtrl', false)).toEqual(['ctrlAlt'])
    expect(matching('cmdShift', true)).toEqual(['cmdShift'])
    expect(matching('cmdShift', false)).toEqual(['ctrlShift'])
  })

  it('Off never matches', () => {
    expect(matching('off', true)).toEqual([])
    expect(matching('off', false)).toEqual([])
  })

  it('works on real pointer and keyboard events', () => {
    expect(quickDragHeld(new MouseEvent('pointerdown', { metaKey: true, ctrlKey: true }), 'cmdCtrl', true)).toBe(true)
    expect(quickDragHeld(new KeyboardEvent('keyup', { metaKey: true }), 'cmdCtrl', true)).toBe(false)
  })
})

describe('quickDragLabel', () => {
  it('shows mac symbols on macOS and key names elsewhere', () => {
    expect(QUICK_DRAG_PRESETS.map((p) => quickDragLabel(p, true))).toEqual(['⌘⌃ + drag', '⌘⇧ + drag', 'Off'])
    expect(QUICK_DRAG_PRESETS.map((p) => quickDragLabel(p, false))).toEqual(['Ctrl+Alt + drag', 'Ctrl+Shift + drag', 'Off'])
  })
})
