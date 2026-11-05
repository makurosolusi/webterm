import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCommands } from './commandRegistry'
import { EDITOR_CHORDS, forwardTabChords, monacoKeybinding } from './editorChords'
import { NEXT_TAB_KEY, PREV_TAB_KEY, TOGGLE_LAYOUT_KEY } from './tabLayout.keys'

// Distinct bits, so a wrong mapping cannot collide by accident.
const keys = {
  KeyMod: { CtrlCmd: 1 << 11, Shift: 1 << 10, Alt: 1 << 9, WinCtrl: 1 << 8 },
  KeyCode: { KeyL: 42, BracketLeft: 88, BracketRight: 90 },
}
const monaco = keys as never

/** Fake Monaco: records keybinding -> handler, and a focused editor that records `trigger`. */
function fakeMonaco() {
  const commands = new Map<string, () => void>()
  const bindings = new Map<number, string>()
  const trigger = vi.fn()
  const api = {
    ...keys,
    editor: {
      registerCommand: (id: string, h: () => void) => { commands.set(id, h); return { dispose() {} } },
      addKeybindingRules: (rules: Array<{ keybinding: number; command: string }>) => { rules.forEach((r) => bindings.set(r.keybinding, r.command)); return { dispose() {} } },
      getEditors: () => [{ hasTextFocus: () => true, trigger }],
    },
  }
  return { api: api as never, trigger, press: (chord: string) => commands.get(bindings.get(monacoKeybinding(chord, monaco))!)!(), count: () => bindings.size }
}

let off = (): void => undefined
afterEach(() => off())

describe('editor chord forwarding', () => {
  it('maps registry chords to Monaco keybindings', () => {
    expect(monacoKeybinding(TOGGLE_LAYOUT_KEY, monaco)).toBe((1 << 11) | (1 << 10) | 42)
    expect(monacoKeybinding(PREV_TAB_KEY, monaco)).toBe((1 << 11) | (1 << 10) | 88)
    expect(monacoKeybinding(NEXT_TAB_KEY, monaco)).toBe((1 << 11) | (1 << 10) | 90)
  })

  it('forwards exactly the tab-layout chords', () => {
    expect(EDITOR_CHORDS.map((c) => c.chord)).toEqual([TOGGLE_LAYOUT_KEY, PREV_TAB_KEY, NEXT_TAB_KEY])
    const m = fakeMonaco()
    forwardTabChords(m.api)
    expect(m.count()).toBe(3)
  })

  it('runs the registered command, else hands the chord back to the Monaco action', () => {
    const toggle = vi.fn()
    off = registerCommands([{ id: 'view.layout.toggle', label: 'x', run: toggle }])
    const m = fakeMonaco()
    forwardTabChords(m.api)

    m.press(TOGGLE_LAYOUT_KEY)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(m.trigger).not.toHaveBeenCalled()

    // Canvas mode: tab.prev is not registered, so the chord still folds.
    m.press(PREV_TAB_KEY)
    expect(m.trigger).toHaveBeenCalledWith('keyboard', 'editor.fold', null)

    const prev = vi.fn()
    off()
    off = registerCommands([{ id: 'tab.prev', label: 'x', run: prev }])
    m.press(PREV_TAB_KEY)
    expect(prev).toHaveBeenCalledTimes(1)
  })
})
