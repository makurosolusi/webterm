// Chords per platform. Root cause locked here: off macOS a keydown with Ctrl is reported as `Mod`
// (eventChord), so a default written `Ctrl+…` (terminal.new's Ctrl+Shift+`) never matched there until
// normalizeChord folded Ctrl into Mod on Linux and Windows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chordLabel, commandForChord, effectiveKey, eventChord, normalizeChord, type Command } from './commandRegistry'
import { commandMatches, conflictsFor, isAppChord, rejectChord } from './keybindings.resolve'
import { monacoKeybinding } from './editorChords'

const PLATFORMS = {
  mac: { isMac: true, isWindows: false },
  linux: { isMac: false, isWindows: false },
  windows: { isMac: false, isWindows: true },
} as const
const ev = (o: Partial<KeyboardEvent>) => ({ type: 'keydown', key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o })
const newTerminal: Command = { id: 'terminal.new', label: 'Terminal: New Terminal', defaultKey: 'Ctrl+Shift+`', run: () => {} }
const ctrlShiftBacktick = ev({ key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true })

describe.each(Object.entries(PLATFORMS))('%s', (_name, p) => {
  it('a Ctrl+ default matches the Ctrl keydown (dispatcher, surface match, terminal hand-back)', () => {
    const chord = eventChord(ctrlShiftBacktick, p.isMac)
    expect(chord).toBe(p.isMac ? 'Ctrl+Shift+`' : 'Mod+Shift+`')
    expect(effectiveKey(newTerminal, {}, p.isMac)).toBe(chord)
    expect(commandMatches(ctrlShiftBacktick, 'terminal.new', [newTerminal], {}, p.isMac)).toBe(true)
    expect(isAppChord(ctrlShiftBacktick, 'app-first', [newTerminal], {}, p)).toBe(true)
  })

  it('Ctrl and Mod are one key off macOS and two on macOS', () => {
    expect(normalizeChord('Ctrl+Shift+K', p.isMac)).toBe(p.isMac ? 'Ctrl+Shift+K' : 'Mod+Shift+K')
    expect(normalizeChord('ctrl+mod+k', p.isMac)).toBe(p.isMac ? 'Mod+Ctrl+K' : 'Mod+K')
    expect(normalizeChord('Meta+K', p.isMac)).toBe('Meta+K') // the Windows / Super key stays its own
    expect(eventChord(ev({ code: 'KeyK', metaKey: true }), p.isMac)).toBe(p.isMac ? 'Mod+K' : 'Meta+K')
  })

  it('labels: symbols on macOS, words elsewhere', () => {
    expect(chordLabel('Ctrl+Shift+`', p.isMac)).toBe(p.isMac ? '⌃⇧`' : 'Ctrl+Shift+`')
    expect(chordLabel('Mod+Shift+F', p.isMac)).toBe(p.isMac ? '⌘⇧F' : 'Ctrl+Shift+F')
  })

  it('a user override written with Ctrl is the same chord as the recorded one', () => {
    const cmd: Command = { id: 'x', label: 'X: Y', run: () => {} }
    expect(effectiveKey(cmd, { x: 'Ctrl+Alt+P' }, p.isMac)).toBe(eventChord(ev({ code: 'KeyP', ctrlKey: true, altKey: true }), p.isMac))
  })
})

describe.each(['Linux x86_64', 'Win32'])('host %s (calls that read the host platform)', (platform) => {
  beforeEach(() => vi.stubGlobal('navigator', { platform }))
  afterEach(() => vi.unstubAllGlobals())

  it('the global dispatcher runs a Ctrl+ default on the Ctrl keydown', () => {
    expect(commandForChord(eventChord(ctrlShiftBacktick, false), [newTerminal], {})?.id).toBe('terminal.new')
  })

  it('conflicts and terminal-owned refusals see Ctrl and Mod as one key', () => {
    expect(conflictsFor('Mod+Shift+`', 'global', [newTerminal], {}).map((c) => c.id)).toEqual(['terminal.new'])
    expect(rejectChord('Ctrl+Shift+C')).toMatch(/copy/)
    expect(rejectChord('Ctrl+Insert')).toMatch(/copy/)
  })

  it('Monaco gets CtrlCmd (the Ctrl key), not WinCtrl (the Windows key), for a Ctrl+ chord', () => {
    const KeyMod = { CtrlCmd: 1 << 11, Shift: 1 << 10, Alt: 1 << 9, WinCtrl: 1 << 8 }
    const KeyCode = { Backquote: 85 }
    const kb = monacoKeybinding('Ctrl+Shift+`', { KeyMod, KeyCode } as never)
    expect(kb & KeyMod.CtrlCmd).toBeTruthy()
    expect(kb & KeyMod.WinCtrl).toBe(0)
  })
})
