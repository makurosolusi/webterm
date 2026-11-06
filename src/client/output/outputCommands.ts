// Shared state and commands for the Output panel: one module store so the status bar item, the
// View menu, the command palette and the shortcut all drive the same panel without prop drilling.
import { useEffect, useSyncExternalStore } from 'react'
import type { LogLevel } from '../../shared/logEntry'
import { toggleBottomView } from '../bottomPanelHost'
import { isMacPlatform } from '../terminalKeys'
import { isOutputToggleChord, outputShortcutLabel } from './outputChord'

/** localStorage key for the open state of the Output panel. */
export const OUTPUT_OPEN_KEY = 'webterm.outputOpen'

export interface OutputPanelState {
  open: boolean
  /** Bumped on every open/focus request; the panel moves focus to its filter when it changes. */
  focusToken: number
  levelPickerOpen: boolean
  counts: { error: number; warn: number }
}

/** Actions backed by the live log stream; registered by the host while it is mounted. */
export interface OutputActions {
  clear: () => Promise<void>
  setLevel: (level: LogLevel) => Promise<void>
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(OUTPUT_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

let state: OutputPanelState = { open: readOpen(), focusToken: 0, levelPickerOpen: false, counts: { error: 0, warn: 0 } }
let actions: OutputActions | null = null
const listeners = new Set<() => void>()

function emit(patch: Partial<OutputPanelState>): void {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

function setOpen(open: boolean): void {
  try {
    localStorage.setItem(OUTPUT_OPEN_KEY, open ? '1' : '0')
  } catch {
    // Private mode: the choice lasts for this tab only.
  }
  emit({ open, focusToken: open ? state.focusToken + 1 : state.focusToken })
}

/** Opens the panel, or moves focus to its filter when it is already open. */
export function openOutput(): void { setOpen(true) }
/** Closes the panel. */
export function closeOutput(): void { setOpen(false) }
/** View: Toggle Output. */
export function toggleOutput(): void { toggleBottomView('output', state.open, setOpen) }
/** Opens the "Set Log Level" quick pick. */
export function openLevelPicker(): void { emit({ levelPickerOpen: true }) }
/** Closes the "Set Log Level" quick pick. */
export function closeLevelPicker(): void { emit({ levelPickerOpen: false }) }
/** Host-only: publishes the error/warning counts shown by the status bar item. */
export function publishOutputCounts(counts: { error: number; warn: number }): void {
  if (counts.error === state.counts.error && counts.warn === state.counts.warn) return
  emit({ counts })
}
/** Host-only: connects the stream actions; returns the disconnect. */
export function registerOutputActions(next: OutputActions): () => void {
  actions = next
  return () => { if (actions === next) actions = null }
}
/** Output: Clear Output. A no-op until the host has registered the stream. */
export async function clearOutput(): Promise<void> { await actions?.clear() }
/** Applies a level chosen in the picker. */
export async function setOutputLevel(level: LogLevel): Promise<void> { await actions?.setLevel(level) }

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Live snapshot of the Output panel state. */
export function useOutputPanelState(): OutputPanelState {
  return useSyncExternalStore(subscribe, () => state)
}

/** Test seam: restore the module to its boot state. */
export function resetOutputStateForTest(): void {
  actions = null
  state = { open: readOpen(), focusToken: 0, levelPickerOpen: false, counts: { error: 0, warn: 0 } }
  listeners.forEach((listener) => listener())
}

/* --- Shortcut --------------------------------------------------------------------------------- */

/** Window-level toggle. Like Clean View it is not gated by typing targets: it needs a modifier chord. */
export function useOutputToggleHotkey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.repeat || !isOutputToggleChord(e, isMacPlatform())) return
      e.preventDefault()
      toggleOutput()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/* --- Palette commands --------------------------------------------------------------------------- */

export interface PaletteCommand {
  id: string
  label: string
  keybinding?: string
  run: () => void
}

/** Command Palette entries, worded as in VS Code. */
export function outputPaletteCommands(isMac: boolean = isMacPlatform()): PaletteCommand[] {
  return [
    { id: 'output.toggle', label: 'View: Toggle Output', keybinding: outputShortcutLabel(isMac), run: toggleOutput },
    { id: 'output.clear', label: 'Output: Clear Output', run: () => void clearOutput() },
    { id: 'output.setLevel', label: 'Output: Set Log Level…', run: openLevelPicker },
  ]
}
