import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chordLabel, commandForChord, effectiveKey, eventChord, findConflicts, listCommands, normalizeChord, registerCommands, type Command,
} from './commandRegistry'
import { FIXED_COMMANDS, appCommands } from './commandRegistry.defaults'

const key = (k: Partial<KeyboardEvent>) => ({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...k })

describe('chords', () => {
  it('normalizes order, case and aliases', () => {
    expect(normalizeChord('shift+mod+f')).toBe('Mod+Shift+F')
    expect(normalizeChord('Cmd+Option+p')).toBe('Mod+Alt+P')
    expect(normalizeChord('Mod++')).toBe('Mod++')
    expect(normalizeChord('Shift')).toBe('')
  })

  it('reads keydowns per platform: ⌘ is Mod on macOS, Ctrl is Mod elsewhere', () => {
    expect(eventChord(key({ key: 'p', code: 'KeyP', metaKey: true }), true)).toBe('Mod+P')
    expect(eventChord(key({ key: 'p', code: 'KeyP', ctrlKey: true }), true)).toBe('Ctrl+P')
    expect(eventChord(key({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true }), false)).toBe('Mod+Shift+F')
    expect(eventChord(key({ key: 'π', code: 'KeyP', altKey: true, metaKey: true }), true)).toBe('Mod+Alt+P')
    expect(eventChord(key({ key: 'Meta', code: 'MetaLeft', metaKey: true }), true)).toBe('')
  })

  it('labels with symbols on macOS and words elsewhere', () => {
    expect(chordLabel('Mod+Shift+F', true)).toBe('⌘⇧F')
    expect(chordLabel('Mod+Shift+F', false)).toBe('Ctrl+Shift+F')
  })
})

describe('bindings and conflicts', () => {
  const a: Command = { id: 'a', label: 'A', defaultKey: 'Mod+K', run: () => {} }
  const b: Command = { id: 'b', label: 'B', defaultKey: 'Mod+J', run: () => {} }
  const editorSave: Command = { id: 'save', label: 'Save', defaultKey: 'Mod+S', scope: 'editor', fixed: true }

  it('user override wins over the default, null removes it, fixed commands ignore overrides', () => {
    expect(effectiveKey(a, {})).toBe('Mod+K')
    expect(effectiveKey(a, { a: 'mod+shift+k' })).toBe('Mod+Shift+K')
    expect(effectiveKey(a, { a: null })).toBeUndefined()
    expect(effectiveKey(editorSave, { save: 'Mod+X' })).toBe('Mod+S')
  })

  it('flags two commands on one chord in the same scope, not across scopes', () => {
    expect(findConflicts([a, b], {}).size).toBe(0)
    const clash = findConflicts([a, b], { b: 'Mod+K' })
    expect(clash.get('a')).toEqual(['b'])
    expect(clash.get('b')).toEqual(['a'])
    expect(findConflicts([a, editorSave], { a: 'Mod+S' }).size).toBe(0)
  })

  it('built-in defaults have no conflicts (files-node ⌘P is scoped, global ⌘P is not)', () => {
    const list = appCommands({
      openOmnibox: vi.fn(), openQuickOpen: vi.fn(), openFindInFiles: vi.fn(), openShortcuts: vi.fn(), openSettings: vi.fn(),
      newTerminal: vi.fn(), newFiles: vi.fn(), fitView: vi.fn(), toggleMaximizeNode: vi.fn(), toggleSessions: vi.fn(), toggleInbox: vi.fn(), toggleChat: vi.fn(), toggleBoard: vi.fn(),
    })
    expect([...findConflicts([...list, ...FIXED_COMMANDS], {}).keys()]).toEqual([])
    expect(list.some((c) => c.id === 'browser.new')).toBe(false) // browser feature off → no command
    expect(FIXED_COMMANDS.every((f) => listCommands().includes(f))).toBe(true) // registered on import
  })

  it('dispatches only global, runnable, non-fixed commands', () => {
    const fixedGlobal: Command = { id: 'fx', label: 'Fx', defaultKey: 'Mod+.', fixed: true, run: () => {} }
    expect(commandForChord('Mod+K', [a, b], {})?.id).toBe('a')
    expect(commandForChord('Mod+S', [editorSave], {})).toBeUndefined()
    expect(commandForChord('Mod+.', [fixedGlobal], {})).toBeUndefined()
    expect(commandForChord('Mod+K', [a, b], { a: 'Mod+L' })).toBeUndefined()
  })
})

describe('registry', () => {
  let off: (() => void) | undefined
  afterEach(() => off?.())

  it('registers, replaces by id, and unregisters', () => {
    off = registerCommands([{ id: 'x.one', label: 'One' }])
    const offTwo = registerCommands([{ id: 'x.one', label: 'One again' }])
    expect(listCommands().filter((c) => c.id === 'x.one').map((c) => c.label)).toEqual(['One again'])
    offTwo()
    expect(listCommands().some((c) => c.id === 'x.one')).toBe(false)
  })
})

describe('diff command', () => {
  it('exists only when the board wires newDiff, and runs it', () => {
    const base = {
      openOmnibox: vi.fn(), openQuickOpen: vi.fn(), openFindInFiles: vi.fn(), openShortcuts: vi.fn(), openSettings: vi.fn(),
      newTerminal: vi.fn(), newFiles: vi.fn(), fitView: vi.fn(), toggleMaximizeNode: vi.fn(), toggleSessions: vi.fn(), toggleInbox: vi.fn(), toggleChat: vi.fn(), toggleBoard: vi.fn(),
    }
    expect(appCommands(base).some((c) => c.id === 'diff.new')).toBe(false)
    const newDiff = vi.fn()
    appCommands({ ...base, newDiff }).find((c) => c.id === 'diff.new')?.run?.()
    expect(newDiff).toHaveBeenCalledOnce()
  })
})
