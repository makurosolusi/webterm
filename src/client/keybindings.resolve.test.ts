import { describe, expect, it } from 'vitest'
import type { Command } from './commandRegistry'
import { commandMatches, conflictsFor, effectiveBindings, isAppChord, rejectChord } from './keybindings.resolve'

const LINUX = { isMac: false, isWindows: false }
const ev = (o: Partial<KeyboardEvent>) => ({ type: 'keydown', key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o })

const find: Command = { id: 'find', label: 'Find', defaultKey: 'Mod+Shift+F', run: () => {} }
const save: Command = { id: 'save', label: 'Save', defaultKey: 'Mod+S', scope: 'editor', fixed: true }
const wrap: Command = { id: 'wrap', label: 'Wrap', defaultKey: 'Alt+Z', scope: 'editor' }
const zoom: Command = { id: 'zoom', label: 'Zoom', defaultKey: 'Mod+=', scope: 'terminal', setting: 'terminalFontZoomKeys' }
const fixedClean: Command = { id: 'view.cleanView', label: 'Clean', defaultKey: 'Mod+.', fixed: true }

describe('effectiveBindings', () => {
  it('reports the live key and where it comes from', () => {
    const out = effectiveBindings([find, save, wrap, zoom], { find: 'Mod+Alt+F', wrap: null, save: 'Mod+X' })
    expect(out.map((b) => [b.cmd.id, b.key, b.source])).toEqual([
      ['find', 'Mod+Alt+F', 'user'],
      ['save', 'Mod+S', 'builtin'], // fixed: overrides ignored
      ['wrap', null, 'user'], // removed by the user
      ['zoom', 'Mod+=', 'setting'],
    ])
    expect(effectiveBindings([find], {})[0].source).toBe('default')
  })
})

describe('conflictsFor', () => {
  it('a global chord clashes with every scope; two different scopes never meet', () => {
    const list = [find, save, wrap]
    expect(conflictsFor('mod+s', 'global', list, {}).map((c) => c.id)).toEqual(['save'])
    expect(conflictsFor('Mod+Shift+F', 'editor', list, {}).map((c) => c.id)).toEqual(['find'])
    expect(conflictsFor('Mod+S', 'terminal', list, {})).toEqual([])
    expect(conflictsFor('Mod+S', 'editor', list, {}).map((c) => c.id)).toEqual(['save'])
    expect(conflictsFor('Alt+Z', 'global', list, { wrap: null })).toEqual([])
  })
})

describe('rejectChord', () => {
  it('refuses keys needed for typing and terminal-owned chords, in English', () => {
    expect(rejectChord('Mod+Shift+K')).toBeNull()
    expect(rejectChord('Alt+Z')).toBeNull()
    expect(rejectChord('F5')).toBeNull()
    expect(rejectChord('Delete')).toBeNull()
    expect(rejectChord('K')).toMatch(/typing/)
    expect(rejectChord('Shift+K')).toMatch(/typing/)
    expect(rejectChord('Mod+C')).toMatch(/copy/)
    expect(rejectChord('Mod+Shift+C')).toMatch(/copy/)
    expect(rejectChord('Mod+Insert')).toMatch(/copy/)
    expect(rejectChord('Shift+Enter')).toMatch(/newline/)
    expect(rejectChord('Mod+V')).toMatch(/paste/)
    expect(rejectChord('')).toMatch(/modifier/)
  })
})

describe('isAppChord', () => {
  it('app-first: bound global chords, not bare Ctrl+letter unless user-bound', () => {
    const omni: Command = { id: 'omni', label: 'O', defaultKey: 'Mod+K', run: () => {} }
    const list = [find, omni, fixedClean, wrap]
    expect(isAppChord(ev({ code: 'KeyF', ctrlKey: true, shiftKey: true }), 'app-first', list, {}, LINUX)).toBe(true)
    expect(isAppChord(ev({ code: 'KeyK', ctrlKey: true }), 'app-first', list, {}, LINUX)).toBe(false)
    expect(isAppChord(ev({ code: 'KeyK', ctrlKey: true }), 'app-first', list, { omni: 'Mod+K' }, LINUX)).toBe(true)
    expect(isAppChord(ev({ code: 'KeyZ', altKey: true }), 'app-first', list, {}, LINUX)).toBe(false) // editor scope, not global
    expect(isAppChord(ev({ code: 'KeyF', ctrlKey: true, shiftKey: true, type: 'keyup' }), 'app-first', list, {}, LINUX)).toBe(false)
  })

  it('terminal-first: only the escape hatch', () => {
    const list = [find, fixedClean]
    expect(isAppChord(ev({ code: 'KeyF', ctrlKey: true, shiftKey: true }), 'terminal-first', list, {}, LINUX)).toBe(false)
    expect(isAppChord(ev({ key: '.', code: 'Period', ctrlKey: true }), 'terminal-first', list, {}, LINUX)).toBe(true)
  })
})

describe('commandMatches', () => {
  it('follows the live binding of one command', () => {
    const e = ev({ code: 'KeyZ', key: 'Ω', altKey: true })
    expect(commandMatches(e, 'wrap', [wrap], {}, true)).toBe(true)
    expect(commandMatches(e, 'wrap', [wrap], { wrap: 'Mod+Alt+W' }, true)).toBe(false)
    expect(commandMatches(e, 'wrap', [wrap], { wrap: null }, true)).toBe(false)
    expect(commandMatches(e, 'missing', [wrap], {}, true)).toBe(false)
  })
})
