import { describe, expect, it } from 'vitest'
import { commandForChord, findConflicts, type Command } from './commandRegistry'
import { FIXED_COMMANDS, SURFACE_COMMANDS, appCommands, type AppCommandDeps } from './commandRegistry.defaults'
import { tabLayoutCommands } from './tabLayout.commands'
import { layersCommands } from './layers.commands'
import { resizeCommand } from './nodeResize/useNodeResizeWiring'
import { OUTPUT_TOGGLE_COMMAND } from './output/outputCommands'
import { CYCLE_APPROVAL_MODE_COMMAND } from './approvalMode.state'
import { terminalKeyAction } from './terminalKeys'
import { HEADER_MODE_COMMANDS, TOGGLE_HEADER_ID, TOGGLE_HEADER_KEY } from './headerMode.commands'
import { getHeaderMode, setHeaderMode } from './headerMode.store'

// Node env, no `localStorage`: also proves the store works with storage unavailable.
const noop = (): void => {}
const deps = new Proxy({}, { get: () => noop }) as AppCommandDeps
/** Every command list the app registers or defines statically, both tab-layout modes included. */
const OTHERS: Command[] = [
  ...FIXED_COMMANDS, ...SURFACE_COMMANDS, ...appCommands(deps), ...tabLayoutCommands(noop, true, true), ...tabLayoutCommands(noop, true, false),
  ...layersCommands(() => []), resizeCommand(() => []), OUTPUT_TOGGLE_COMMAND, CYCLE_APPROVAL_MODE_COMMAND,
]
const ALL: Command[] = [...OTHERS, ...HEADER_MODE_COMMANDS]
const MAC = { isMac: true, isWindows: false }
const LINUX = { isMac: false, isWindows: false }

describe('header mode commands', () => {
  it('registers one command per mode plus the toggle, all in the View category', () => {
    expect(HEADER_MODE_COMMANDS.map((c) => c.id)).toEqual(['view.header.tabs', 'view.header.hidden', TOGGLE_HEADER_ID])
    expect(HEADER_MODE_COMMANDS.map((c) => c.label)).toEqual(['View: Header: Tabs', 'View: Header: Hidden', 'View: Toggle Header'])
    expect(HEADER_MODE_COMMANDS.filter((c) => c.defaultKey).map((c) => [c.id, c.defaultKey])).toEqual([[TOGGLE_HEADER_ID, 'Mod+Shift+H']])
  })

  it('the chord is free: no other command uses it, in any scope, and nothing conflicts', () => {
    expect(OTHERS.filter((c) => c.defaultKey === TOGGLE_HEADER_KEY)).toEqual([])
    expect(OTHERS.some((c) => c.defaultKey?.toLowerCase() === 'mod+alt+h')).toBe(false) // the rejected alternative stays unused
    const conflicts = findConflicts(ALL, {})
    expect([...conflicts.keys()].filter((id) => id.startsWith('view.header'))).toEqual([])
  })

  it('a keydown of the chord resolves to the toggle in every scope (terminal, editor, files, browser, canvas)', () => {
    for (const scopes of [[], ['terminal'], ['editor'], ['files'], ['browser'], ['canvas']] as const) {
      expect(commandForChord(TOGGLE_HEADER_KEY, ALL, {}, scopes)?.id).toBe(TOGGLE_HEADER_ID)
    }
  })

  it('a focused terminal hands the chord to the app (app-first), on macOS and elsewhere', () => {
    const mac = { type: 'keydown' as const, key: 'H', code: 'KeyH', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }
    const lin = { ...mac, metaKey: false, ctrlKey: true }
    expect(terminalKeyAction(mac, 'app-first', MAC, ALL, {})).toBe('bubble')
    expect(terminalKeyAction(lin, 'app-first', LINUX, ALL, {})).toBe('bubble')
  })

  it('running the commands changes the stored mode; the toggle goes Hidden and back to Tabs', () => {
    const run = (id: string): void => HEADER_MODE_COMMANDS.find((c) => c.id === id)?.run?.()
    run('view.header.hidden')
    expect(getHeaderMode()).toBe('hidden')
    run('view.header.tabs')
    expect(getHeaderMode()).toBe('tabs')
    run(TOGGLE_HEADER_ID)
    expect(getHeaderMode()).toBe('hidden')
    run(TOGGLE_HEADER_ID)
    expect(getHeaderMode()).toBe('tabs')
    setHeaderMode('tabs')
  })
})
