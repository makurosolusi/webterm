import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chordLabel, commandForChord, effectiveKey, eventChord, findConflicts, listCommands, normalizeChord, registerCommands, type Command,
} from './commandRegistry'
import { FIXED_COMMANDS, appCommands } from './commandRegistry.defaults'
import { openSetup } from './setup/setup.open'

vi.mock('./setup/setup.open', () => ({ openSetup: vi.fn() }))
const startScreenshot = vi.hoisted(() => vi.fn())
vi.mock('./screenshot/ui/screenshot.start', () => ({ startScreenshot }))

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
    // A per-instance palette entry: a stale override can never bind it (nor clash with it).
    const perWs: Command = { id: 'ws.1', label: 'Agents: Continue in A', bindable: false, run: () => {} }
    expect(effectiveKey(perWs, { 'ws.1': 'Mod+K' })).toBeUndefined()
    expect(findConflicts([a, perWs], { 'ws.1': 'Mod+K' }).size).toBe(0)
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
      newTerminal: vi.fn(), newFiles: vi.fn(), fitView: vi.fn(), toggleMaximizeNode: vi.fn(), toggleSessions: vi.fn(), toggleChat: vi.fn(), toggleSecondarySideBar: vi.fn(), toggleBoard: vi.fn(),
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

describe('dispatch precedence', () => {
  const g1: Command = { id: 'g1', label: 'G1', defaultKey: 'Mod+J', run: () => {} }
  const g2: Command = { id: 'g2', label: 'G2', defaultKey: 'Mod+K', run: () => {} }
  const ed: Command = { id: 'ed', label: 'Ed', defaultKey: 'Mod+J', scope: 'editor', run: () => {} }

  it('a scoped command beats a global one only while its scope is active', () => {
    expect(commandForChord('Mod+J', [g1, ed], {}, ['editor'])?.id).toBe('ed')
    expect(commandForChord('Mod+J', [g1, ed], {}, ['terminal'])?.id).toBe('g1')
    expect(commandForChord('Mod+J', [g1, ed], {})?.id).toBe('g1')
  })

  it('in one scope the most recent user override wins, and the clash is warned once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(commandForChord('Mod+J', [g1, g2], { g2: 'Mod+J' })?.id).toBe('g2')
    expect(commandForChord('Mod+J', [g2, g1], { g1: 'Mod+J', g2: 'Mod+J' })?.id).toBe('g2')
    expect(commandForChord('Mod+J', [g2, g1], { g2: 'Mod+J', g1: 'Mod+J' })?.id).toBe('g1')
    commandForChord('Mod+J', [g1, g2], { g2: 'Mod+J' })
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('g1, g2'))).toHaveLength(1)
    warn.mockRestore()
  })

  it('maps punctuation by physical key, so Shift and macOS Option do not change the chord', () => {
    expect(eventChord(key({ key: '≠', code: 'Equal', metaKey: true, altKey: true }), true)).toBe('Mod+Alt+=')
    expect(eventChord(key({ key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true }), true)).toBe('Ctrl+Shift+`')
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
  it('"Setup: Open" opens the setup wizard', () => {
    const base = {
      openOmnibox: vi.fn(), openQuickOpen: vi.fn(), openFindInFiles: vi.fn(), openShortcuts: vi.fn(), openSettings: vi.fn(),
      newTerminal: vi.fn(), newFiles: vi.fn(), fitView: vi.fn(), toggleMaximizeNode: vi.fn(), toggleSessions: vi.fn(), toggleChat: vi.fn(), toggleSecondarySideBar: vi.fn(), toggleBoard: vi.fn(),
    }
    const cmd = appCommands(base).find((c) => c.label === 'Setup: Open')
    cmd?.run?.()
    expect(openSetup).toHaveBeenCalledOnce()
  })

  it('exists only when the board wires newDiff, and runs it', () => {
    const base = {
      openOmnibox: vi.fn(), openQuickOpen: vi.fn(), openFindInFiles: vi.fn(), openShortcuts: vi.fn(), openSettings: vi.fn(),
      newTerminal: vi.fn(), newFiles: vi.fn(), fitView: vi.fn(), toggleMaximizeNode: vi.fn(), toggleSessions: vi.fn(), toggleChat: vi.fn(), toggleSecondarySideBar: vi.fn(), toggleBoard: vi.fn(),
    }
    expect(appCommands(base).some((c) => c.id === 'diff.new')).toBe(false)
    const newDiff = vi.fn()
    appCommands({ ...base, newDiff }).find((c) => c.id === 'diff.new')?.run?.()
    expect(newDiff).toHaveBeenCalledOnce()
  })
})

describe('screenshot command', () => {
  const base = {
    openOmnibox: vi.fn(), openQuickOpen: vi.fn(), openFindInFiles: vi.fn(), openShortcuts: vi.fn(), openSettings: vi.fn(),
    newTerminal: vi.fn(), newFiles: vi.fn(), fitView: vi.fn(), toggleMaximizeNode: vi.fn(), toggleSessions: vi.fn(), toggleChat: vi.fn(), toggleSecondarySideBar: vi.fn(), toggleBoard: vi.fn(),
  }

  it('"Canvas: Take Screenshot" is a global, bound command that starts the annotator', () => {
    const cmd = appCommands(base).find((c) => c.id === 'canvas.screenshot')
    expect(cmd).toMatchObject({ label: 'Canvas: Take Screenshot', defaultKey: 'Mod+Shift+S' })
    expect(cmd?.scope).toBeUndefined() // global
    cmd?.run?.()
    expect(startScreenshot).toHaveBeenCalledOnce()
  })

  it('its chord is free in every scope (global clashes with all of them) and dispatches to it', () => {
    const all = [...appCommands(base), ...FIXED_COMMANDS, ...listCommands()]
    const holders = all.filter((c) => c.id !== 'canvas.screenshot' && effectiveKey(c, {}) === 'Mod+Shift+S')
    expect(holders.map((c) => c.id)).toEqual([])
    expect(commandForChord('Mod+Shift+S', appCommands(base), {})?.id).toBe('canvas.screenshot')
  })
})
