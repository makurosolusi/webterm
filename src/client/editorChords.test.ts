import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCommands } from './commandRegistry'
import { EDITOR_CHORDS, editorChordRules, forwardEditorChords, monacoKeybinding } from './editorChords'
import { connectKeybindings } from './keybindings.store'
import { NEXT_TAB_KEY, PREV_TAB_KEY, TOGGLE_LAYOUT_KEY } from './tabLayout.keys'

// Distinct bits, so a wrong mapping cannot collide by accident.
const keys = {
  KeyMod: { CtrlCmd: 1 << 11, Shift: 1 << 10, Alt: 1 << 9, WinCtrl: 1 << 8 },
  KeyCode: { KeyL: 42, KeyJ: 40, KeyK: 41, KeyZ: 56, BracketLeft: 88, BracketRight: 90, Backslash: 93, F5: 63 },
}
const monaco = keys as never

/** Fake Monaco: live keybinding -> command and command -> handler, both honouring dispose. */
function fakeMonaco() {
  const commands = new Map<string, () => void>()
  const bindings = new Map<number, string>()
  const trigger = vi.fn()
  const api = {
    ...keys,
    editor: {
      registerCommand: (id: string, h: () => void) => { commands.set(id, h); return { dispose: () => commands.delete(id) } },
      addKeybindingRules: (rules: Array<{ keybinding: number; command: string }>) => {
        rules.forEach((r) => bindings.set(r.keybinding, r.command))
        return { dispose: () => rules.forEach((r) => bindings.delete(r.keybinding)) }
      },
      getEditors: () => [{ hasTextFocus: () => true, trigger }],
    },
  }
  const press = (chord: string): boolean => {
    const h = commands.get(bindings.get(monacoKeybinding(chord, monaco)) ?? '')
    h?.()
    return !!h
  }
  return { api: api as never, trigger, press, count: () => bindings.size }
}

const offs: Array<() => void> = []
afterEach(() => { offs.splice(0).forEach((f) => f()); connectKeybindings({}, null); vi.unstubAllGlobals() })

describe('editor chord forwarding', () => {
  it('maps registry chords to Monaco keybindings', () => {
    expect(monacoKeybinding(TOGGLE_LAYOUT_KEY, monaco)).toBe((1 << 11) | (1 << 10) | 42)
    expect(monacoKeybinding(PREV_TAB_KEY, monaco)).toBe((1 << 11) | (1 << 10) | 88)
    expect(monacoKeybinding(NEXT_TAB_KEY, monaco)).toBe((1 << 11) | (1 << 10) | 90)
    expect(monacoKeybinding('Mod+Shift+\\', monaco)).toBe((1 << 11) | (1 << 10) | 93)
    expect(monacoKeybinding('Alt+Z', monaco)).toBe((1 << 9) | 56)
    expect(monacoKeybinding('F5', monaco)).toBe(63)
    expect(monacoKeybinding('Mod+Q', monaco)).toBe(0) // no code in this fake: skipped, not bit soup
  })

  it('maps Ctrl by platform: WinCtrl on macOS, the primary modifier (CtrlCmd) elsewhere', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(monacoKeybinding('Ctrl+K', monaco)).toBe((1 << 8) | 41)
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    expect(monacoKeybinding('Ctrl+K', monaco)).toBe((1 << 11) | 41)
  })

  it('forwards exactly the tab-layout chords by default', () => {
    expect(EDITOR_CHORDS.map((c) => c.chord)).toEqual([TOGGLE_LAYOUT_KEY, PREV_TAB_KEY, NEXT_TAB_KEY])
    const m = fakeMonaco()
    offs.push(forwardEditorChords(m.api))
    expect(m.count()).toBe(3)
  })

  it('runs the registered command, else hands the chord back to the Monaco action', () => {
    const toggle = vi.fn()
    const offToggle = registerCommands([{ id: 'view.layout.toggle', label: 'x', run: toggle }])
    offs.push(offToggle)
    const m = fakeMonaco()
    offs.push(forwardEditorChords(m.api))

    m.press(TOGGLE_LAYOUT_KEY)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(m.trigger).not.toHaveBeenCalled()

    // Canvas mode: tab.prev is not registered, so the chord still folds.
    m.press(PREV_TAB_KEY)
    expect(m.trigger).toHaveBeenCalledWith('keyboard', 'editor.fold', null)

    const prev = vi.fn()
    offs.push(registerCommands([{ id: 'tab.prev', label: 'x', run: prev }]))
    m.press(PREV_TAB_KEY)
    expect(prev).toHaveBeenCalledTimes(1)
  })

  it('re-applies the rules when overrides change, disposing the previous ones', () => {
    const run = vi.fn()
    const toggle = vi.fn()
    offs.push(registerCommands([{ id: 'x.open', label: 'x', defaultKey: 'Mod+J', run }, { id: 'view.layout.toggle', label: 'x', run: toggle }]))
    const m = fakeMonaco()
    offs.push(forwardEditorChords(m.api))
    expect(m.press('Mod+J')).toBe(false) // not rebound: Monaco keeps its own chord

    connectKeybindings({ 'x.open': 'Mod+K', 'view.layout.toggle': 'Mod+Shift+J' }, null)
    expect(m.press('Mod+K')).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(m.press(TOGGLE_LAYOUT_KEY)).toBe(false) // the old chord is released back to Monaco
    expect(m.press('Mod+Shift+J')).toBe(true)
    expect(toggle).toHaveBeenCalledTimes(1)

    connectKeybindings({}, null)
    expect(m.press('Mod+K')).toBe(false)
    expect(m.press(TOGGLE_LAYOUT_KEY)).toBe(true)
  })

  it('a removed tab chord is not forwarded', () => {
    expect(editorChordRules([], { 'tab.prev': null }).map((c) => c.command)).toEqual(['view.layout.toggle', 'tab.next'])
  })
})
