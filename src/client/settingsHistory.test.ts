import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { applySettingsPatch, type SettingsPatch } from '../shared/settings.patch'
import { createSettingsHistory, settingsKeyLabel } from './settingsHistory'

/** Apply patches like `useSettings` does, recording each one first. */
function harness(opts: { cap?: number; coalesceMs?: number } = {}) {
  let t = 0
  let s: Settings = { ...DEFAULT_SETTINGS }
  const h = createSettingsHistory({ ...opts, now: () => t })
  return {
    h,
    get s() { return s },
    tick(ms: number) { t += ms },
    edit(patch: SettingsPatch) { h.record(s, patch); s = applySettingsPatch(s, patch) },
    undo() { const c = h.undo(); if (c) s = applySettingsPatch(s, c.before); return c },
    redo() { const c = h.redo(); if (c) s = applySettingsPatch(s, c.after); return c },
  }
}

describe('createSettingsHistory', () => {
  it('undo restores the previous value and redo re-applies it', () => {
    const x = harness()
    x.edit({ fontSize: 20 })
    expect(x.h.canUndo()).toBe(true)
    expect(x.undo()?.keys).toEqual(['fontSize'])
    expect(x.s.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
    expect(x.h.canRedo()).toBe(true)
    x.redo()
    expect(x.s.fontSize).toBe(20)
    expect(x.h.canRedo()).toBe(false)
  })

  it('undo of one workspace entry deletes only that entry and keeps the others', () => {
    const x = harness()
    const bg = DEFAULT_SETTINGS.canvasBackground
    x.edit({ canvasBackgroundByWorkspace: { w1: bg } })
    x.tick(5000)
    x.edit({ canvasBackgroundByWorkspace: { w2: { ...bg, mode: 'gradient' } } })
    x.undo()
    expect(Object.keys(x.s.canvasBackgroundByWorkspace)).toEqual(['w1'])
    x.undo()
    expect(x.s.canvasBackgroundByWorkspace).toEqual({})
  })

  it('a slider drag (same key, inside the window) is ONE step back to the start value', () => {
    const x = harness({ coalesceMs: 1000 })
    for (const v of [15, 16, 17, 18]) { x.edit({ fontSize: v }); x.tick(100) }
    x.undo()
    expect(x.s.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
    expect(x.h.canUndo()).toBe(false)
  })

  it('edits further apart than the window, or to other keys, are separate steps', () => {
    const x = harness({ coalesceMs: 1000 })
    x.edit({ fontSize: 15 })
    x.tick(1500)
    x.edit({ fontSize: 16 })
    x.edit({ cursorBlink: !DEFAULT_SETTINGS.cursorBlink })
    x.undo()
    expect(x.s.cursorBlink).toBe(DEFAULT_SETTINGS.cursorBlink)
    expect(x.s.fontSize).toBe(16)
    x.undo()
    expect(x.s.fontSize).toBe(15)
  })

  it('keeps only the last N changes', () => {
    const x = harness({ cap: 3, coalesceMs: 0 })
    for (const v of [11, 12, 13, 14, 15]) x.edit({ fontSize: v })
    let n = 0
    while (x.undo()) n++
    expect(n).toBe(3)
    expect(x.s.fontSize).toBe(12) // the two oldest steps fell off
  })

  it('a new edit after undo drops the redo tail', () => {
    const x = harness({ coalesceMs: 0 })
    x.edit({ fontSize: 15 })
    x.undo()
    x.edit({ fontSize: 30 })
    expect(x.h.canRedo()).toBe(false)
    x.undo()
    expect(x.s.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
  })

  it('no-op patches are not steps, and a drag back to the start removes its step', () => {
    const x = harness()
    expect(x.h.record(x.s, { fontSize: x.s.fontSize })).toBeUndefined()
    x.edit({ fontSize: 15 })
    x.edit({ fontSize: DEFAULT_SETTINGS.fontSize })
    expect(x.h.canUndo()).toBe(false)
  })

  it('an undone-then-redone step does not swallow the next edit of the same key', () => {
    const x = harness({ coalesceMs: 10_000 })
    x.edit({ fontSize: 15 })
    x.undo()
    x.redo()
    x.edit({ fontSize: 16 })
    x.undo()
    expect(x.s.fontSize).toBe(15)
  })

  it('compares structured values by content (arrays/objects)', () => {
    const x = harness()
    expect(x.h.record(x.s, { disabledAgents: [...x.s.disabledAgents] })).toBeUndefined()
  })
})

describe('settingsKeyLabel', () => {
  it('turns camelCase keys into words', () => {
    expect(settingsKeyLabel(['fontSize', 'cursorBlink'])).toBe('font size, cursor blink')
  })
})
