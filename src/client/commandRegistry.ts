// One command registry for the palette (⌘K omnibox), the global shortcut dispatcher and the
// Keyboard Shortcuts overlay. Imitates VS Code: a command has an id, a label ("Category: Action"),
// a default keybinding, and `keybindings.json`-style user overrides (here `keybindings.store.ts`).
// Commands owned by another surface (Monaco save, terminal Shift+Enter, ...) are registered as
// `fixed`: listed and conflict-checked, never dispatched from here.
import { useEffect, useSyncExternalStore } from 'react'
import { isMacPlatform } from './terminalKeys'
import { useKeybindingOverrides, type KeybindingOverrides } from './keybindings.store'

/** Where a keybinding is live; conflicts only count inside one scope (VS Code `when`). */
export type CommandScope = 'global' | 'editor' | 'terminal' | 'files' | 'canvas'

export interface Command {
  id: string
  /** "Category: Action", as VS Code words palette entries. */
  label: string
  /** Chord like `Mod+Shift+F` (`Mod` = ⌘ on macOS, Ctrl elsewhere). */
  defaultKey?: string
  /** Non-key trigger shown in the overlay, e.g. "Double-click edge". */
  gesture?: string
  scope?: CommandScope
  /** Handled by its own surface: shown and conflict-checked, not dispatched or rebindable. */
  fixed?: boolean
  /** Hidden from the palette (still in the overlay). */
  hidden?: boolean
  run?: () => void
}

let commands: Command[] = []
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((l) => l())

/** Adds commands (same id replaces); returns the matching unregister. */
export function registerCommands(list: Command[]): () => void {
  const ids = new Set(list.map((c) => c.id))
  commands = [...commands.filter((c) => !ids.has(c.id)), ...list]
  emit()
  return () => {
    commands = commands.filter((c) => !list.includes(c))
    emit()
  }
}

export const listCommands = (): readonly Command[] => commands
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
/** Live command list. */
export const useCommands = (): readonly Command[] => useSyncExternalStore(subscribe, listCommands)
/** Registers `list` while mounted (memoise it: a new array re-registers). */
export function useRegisterCommands(list: Command[]): void {
  useEffect(() => registerCommands(list), [list])
}

/* --- Chords ----------------------------------------------------------------------------------- */

const MOD_ORDER = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift']
const KEY_ALIASES: Record<string, string> = { esc: 'Escape', del: 'Delete', cmd: 'Mod', command: 'Mod', control: 'Ctrl', option: 'Alt', plus: '+' }

/** Canonical chord text (`mod+shift+f` → `Mod+Shift+F`); empty string for nothing usable. */
export function normalizeChord(chord: string): string {
  const parts = chord.split(/\+(?!$)/).map((p) => p.trim()).filter(Boolean)
  const mods = new Set<string>()
  let key = ''
  for (const raw of parts) {
    const p = KEY_ALIASES[raw.toLowerCase()] ?? raw
    const mod = MOD_ORDER.find((m) => m.toLowerCase() === p.toLowerCase())
    if (mod) mods.add(mod)
    else key = p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)
  }
  return key ? [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+') : ''
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

/** Chord of a keydown, platform resolved (`Mod` = ⌘ on macOS, Ctrl elsewhere); '' for a bare modifier. */
export function eventChord(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, isMac: boolean): string {
  if (MODIFIER_KEYS.has(e.key)) return ''
  // Letters/digits by physical code: Alt/Shift change `key` (⌥P = π) but not the chord.
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.key
  const mods = [
    (isMac ? e.metaKey : e.ctrlKey) && 'Mod',
    isMac && e.ctrlKey && 'Ctrl',
    !isMac && e.metaKey && 'Meta',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
  ].filter(Boolean)
  return normalizeChord([...mods, key].join('+'))
}

const MAC_LABELS: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘', Backspace: '⌫', Delete: '⌦', Escape: 'Esc', Enter: '↩' }
/** Chord split into display chips: symbols on macOS, words elsewhere. */
export function chordKeys(chord: string, isMac: boolean): string[] {
  return normalizeChord(chord).split('+').filter(Boolean).map((k) => (isMac ? MAC_LABELS[k] ?? k : k === 'Mod' ? 'Ctrl' : k))
}
/** One-line label (`⇧⌘F` / `Ctrl+Shift+F`) for palette rows and tooltips. */
export const chordLabel = (chord: string, isMac: boolean): string => chordKeys(chord, isMac).join(isMac ? '' : '+')

/* --- Effective bindings + conflicts --------------------------------------------------------- */

/** The chord a command answers to: user override (`null` = removed) over its default. */
export function effectiveKey(cmd: Command, overrides: KeybindingOverrides): string | undefined {
  if (!cmd.fixed && Object.hasOwn(overrides, cmd.id)) return overrides[cmd.id] ? normalizeChord(overrides[cmd.id] as string) : undefined
  return cmd.defaultKey ? normalizeChord(cmd.defaultKey) : undefined
}

/** Command ids that share a chord with another command in the same scope, per command id. */
export function findConflicts(list: readonly Command[], overrides: KeybindingOverrides): Map<string, string[]> {
  const byChord = new Map<string, Command[]>()
  for (const c of list) {
    const k = effectiveKey(c, overrides)
    if (!k) continue
    const slot = `${c.scope ?? 'global'}|${k}`
    byChord.set(slot, [...(byChord.get(slot) ?? []), c])
  }
  const out = new Map<string, string[]>()
  for (const group of byChord.values()) {
    if (group.length < 2) continue
    for (const c of group) out.set(c.id, group.filter((o) => o !== c).map((o) => o.id))
  }
  return out
}

/** The global, dispatchable command bound to `chord`, if any (first registered wins a conflict). */
export function commandForChord(chord: string, list: readonly Command[], overrides: KeybindingOverrides): Command | undefined {
  if (!chord) return undefined
  return list.find((c) => !c.fixed && c.run && (c.scope ?? 'global') === 'global' && effectiveKey(c, overrides) === chord)
}

const isEditable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')

/**
 * Global shortcut dispatcher. On `document`, bubble phase: surfaces that own a key (Monaco,
 * xterm when it sends the key to the shell, a focused Files node's ⌘P) stop it first, and a hit
 * here stops it before the older window listeners (CanvasToolbar's ⌘K) see it.
 */
export function useCommandKeybindings(): void {
  const overrides = useKeybindingOverrides()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const chord = eventChord(e, isMacPlatform())
      // Plain keys belong to whatever text field has focus; only chords with a modifier reach commands there.
      if (isEditable(e.target) && !/^(Mod|Ctrl|Meta|Alt)\+/.test(chord)) return
      const cmd = commandForChord(chord, listCommands(), overrides)
      if (!cmd) return
      e.preventDefault()
      e.stopPropagation()
      cmd.run?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [overrides])
}
