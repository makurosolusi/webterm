// Pure keybinding resolution over the command registry and the user overrides: what each command
// answers to and why, which commands a chord would clash with, which chords a recorder must refuse,
// and which keydowns a focused terminal hands back to the app instead of writing to the shell.
import type { TerminalShortcutPolicy } from '../shared/settings'
import { effectiveKey, eventChord, listCommands, normalizeChord, type Command, type CommandScope } from './commandRegistry'
import { keybindingOverrides, type KeybindingOverrides } from './keybindings.store'
import { hostPlatform, isMacPlatform, type KeyPlatform } from './terminalKeys.platform'

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & { type?: string }

/** Where a binding comes from: its default, a user override, a fixed built-in, or gated by a setting. */
export type BindingSource = 'default' | 'user' | 'builtin' | 'setting'

export interface EffectiveBinding {
  cmd: Command
  key: string | null
  source: BindingSource
}

const isUser = (cmd: Command, overrides: KeybindingOverrides): boolean => !cmd.fixed && Object.hasOwn(overrides, cmd.id)

/** Every command with the chord it answers to now and where that chord comes from. */
export function effectiveBindings(list: readonly Command[], overrides: KeybindingOverrides): EffectiveBinding[] {
  return list.map((cmd) => ({
    cmd,
    key: effectiveKey(cmd, overrides) ?? null,
    source: cmd.fixed ? 'builtin' : isUser(cmd, overrides) ? 'user' : cmd.setting ? 'setting' : 'default',
  }))
}

const scopeOf = (c: Command): CommandScope => c.scope ?? 'global'
/** A global binding is live in every scope, so it clashes with all of them; two other scopes never meet. */
const fireTogether = (a: CommandScope, b: CommandScope): boolean => a === b || a === 'global' || b === 'global'

/** Commands already answering to `chord` that would fire alongside a binding in `scope`. */
export function conflictsFor(chord: string, scope: CommandScope, list: readonly Command[], overrides: KeybindingOverrides): Command[] {
  const k = normalizeChord(chord)
  if (!k) return []
  return list.filter((c) => effectiveKey(c, overrides) === k && fireTogether(scope, scopeOf(c)))
}

const BARE_OK = /^(F\d{1,2}|Delete|Backspace)$/
/** Chords a terminal owns (copy, newline, Windows paste); rebinding them would break the terminal. */
const TERMINAL_OWNED: Record<string, string> = {
  'Mod+C': 'is the terminal copy shortcut (Ctrl+C also interrupts the running program)',
  'Mod+Shift+C': 'is the terminal copy shortcut',
  'Ctrl+Shift+C': 'is the terminal copy shortcut',
  'Mod+Insert': 'is the terminal copy shortcut',
  'Ctrl+Insert': 'is the terminal copy shortcut',
  'Shift+Enter': 'inserts a newline in terminals',
  'Mod+V': 'is the paste shortcut',
}

/** Why `chord` cannot be used as a keybinding, or null when it can. */
export function rejectChord(chord: string): string | null {
  const k = normalizeChord(chord)
  if (!k) return 'Press a key together with a modifier.'
  if (TERMINAL_OWNED[k]) return `${k} ${TERMINAL_OWNED[k]}.`
  const key = k.split(/\+(?!$)/).pop() ?? ''
  const mods = k.slice(0, -key.length)
  if (!/(Mod|Ctrl|Meta|Alt)\+/.test(mods) && !BARE_OK.test(key)) {
    return 'Add Ctrl, Alt or ⌘ to this key: on its own (or with only Shift) it is needed for typing.'
  }
  return null
}

/** Clean View is the way back from a chrome-less screen: it bubbles out of a terminal under every policy. */
const ESCAPE_HATCH = new Set(['view.cleanView'])

/**
 * True when a keydown in a focused terminal belongs to the app (xterm must not write it to the shell).
 * `app-first`: any chord of a global command (runnable, or fixed and window-handled), except a bare
 * Ctrl+letter (Ctrl+R, Ctrl+K... are shell keys) unless the user bound it explicitly.
 * `terminal-first`: only the escape hatch.
 */
export function isAppChord(
  e: KeyLike, policy: TerminalShortcutPolicy, list: readonly Command[], overrides: KeybindingOverrides,
  platform: KeyPlatform = hostPlatform(),
): boolean {
  if (e.type !== undefined && e.type !== 'keydown') return false
  const chord = eventChord(e, platform.isMac)
  if (!chord) return false
  const bareCtrl = (platform.isMac ? /^Ctrl\+[A-Z]$/ : /^Mod\+[A-Z]$/).test(chord)
  return list.some((c) =>
    scopeOf(c) === 'global' && (c.run || c.fixed) && effectiveKey(c, overrides, platform.isMac) === chord &&
    (ESCAPE_HATCH.has(c.id) || (policy === 'app-first' && (!bareCtrl || isUser(c, overrides)))))
}

/** The live chord of command `id`, if it is registered and bound. */
export function commandKey(
  id: string, list: readonly Command[] = listCommands(), overrides: KeybindingOverrides = keybindingOverrides(), isMac: boolean = isMacPlatform(),
): string | undefined {
  const cmd = list.find((c) => c.id === id)
  return cmd && effectiveKey(cmd, overrides, isMac)
}

/** True when `e` is the live chord of command `id`: how a surface dispatches its own scoped commands. */
export function commandMatches(
  e: KeyLike, id: string, list: readonly Command[] = listCommands(), overrides: KeybindingOverrides = keybindingOverrides(),
  isMac: boolean = isMacPlatform(),
): boolean {
  const key = commandKey(id, list, overrides, isMac)
  return !!key && eventChord(e, isMac) === key
}
