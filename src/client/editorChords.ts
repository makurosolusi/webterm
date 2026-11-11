// Monaco handles a keydown it has a binding for and stops it, so the window command dispatcher never
// sees it: Mod+Shift+L is "Select All Occurrences" and Mod+Shift+[ / ] are fold / unfold. Like
// `terminalKeys` does for xterm, hand app chords back to the command registry: the tab-layout chords
// always, plus every global command the user rebound (a user binding beats Monaco's built-in one, as
// in VS Code). Wired once from `lazyMonaco` through the public `addKeybindingRules` API (a later
// binding for the same chord overrides Monaco's), and re-applied whenever overrides or the command
// list change, disposing the previous rules. Keybindings are global in Monaco (one shared service),
// so this is not per editor: an editor's `addCommand` is not even usable from `onDidCreateEditor`.
import type * as Monaco from 'monaco-editor'
import { effectiveKey, listCommands, normalizeChord, subscribeCommands, type Command } from './commandRegistry'
import { keybindingOverrides, subscribeKeybindings, type KeybindingOverrides } from './keybindings.store'
import { NEXT_TAB_KEY, PREV_TAB_KEY, TOGGLE_LAYOUT_KEY } from './tabLayout.keys'

export interface EditorChord {
  /** Registry chord text (`Mod+Shift+L`). */
  chord: string
  /** Registry command to run; when it is not registered right now (tab keys exist only in tab mode)... */
  command: string
  /** ...the Monaco action that owned the chord keeps working. */
  fallback?: string
}

export const EDITOR_CHORDS: readonly EditorChord[] = [
  { chord: TOGGLE_LAYOUT_KEY, command: 'view.layout.toggle' },
  { chord: PREV_TAB_KEY, command: 'tab.prev', fallback: 'editor.fold' },
  { chord: NEXT_TAB_KEY, command: 'tab.next', fallback: 'editor.unfold' },
]

type MonacoKeys = Pick<typeof Monaco, 'KeyMod' | 'KeyCode'>

const NAMED_KEYS: Record<string, string> = {
  '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon',
  "'": 'Quote', '`': 'Backquote', '-': 'Minus', '=': 'Equal', ' ': 'Space', ArrowUp: 'UpArrow', ArrowDown: 'DownArrow',
  ArrowLeft: 'LeftArrow', ArrowRight: 'RightArrow',
}

/** Monaco keybinding number for a registry chord; 0 when Monaco has no code for its key. */
export function monacoKeybinding(chord: string, { KeyMod, KeyCode }: MonacoKeys): number {
  const parts = normalizeChord(chord).split(/\+(?!$)/)
  const key = parts.pop() ?? ''
  const name = /^[A-Z]$/.test(key) ? `Key${key}` : /^\d$/.test(key) ? `Digit${key}` : NAMED_KEYS[key] ?? key
  const code: unknown = (KeyCode as unknown as Record<string, unknown>)[name]
  if (typeof code !== 'number' || !code) return 0
  // Ctrl on macOS and Meta (the Windows key) elsewhere are both Monaco's WinCtrl.
  const mods: Record<string, number> = { Mod: KeyMod.CtrlCmd, Shift: KeyMod.Shift, Alt: KeyMod.Alt, Ctrl: KeyMod.WinCtrl, Meta: KeyMod.WinCtrl }
  return parts.reduce((bits, mod) => bits | mods[mod], code)
}

/** Chords to forward now: the tab-layout chords (following their overrides) and every rebound global command. */
export function editorChordRules(list: readonly Command[], overrides: KeybindingOverrides): EditorChord[] {
  const out = EDITOR_CHORDS.map((c) => {
    if (!Object.hasOwn(overrides, c.command)) return c
    const k = overrides[c.command]
    return { ...c, chord: k ? normalizeChord(k) : '' }
  })
  for (const c of list) {
    const global = !c.scope || c.scope === 'global'
    if (!global || c.fixed || !c.run || !Object.hasOwn(overrides, c.id) || out.some((o) => o.command === c.id)) continue
    out.push({ chord: effectiveKey(c, overrides) ?? '', command: c.id })
  }
  return out.filter((c) => c.chord)
}

type ChordApi = MonacoKeys & { editor: Pick<typeof Monaco.editor, 'addKeybindingRules' | 'registerCommand' | 'getEditors'> }

/** Pass app chords through every Monaco editor to the command registry; returns the stop function. */
export function forwardEditorChords(monaco: ChordApi): () => void {
  let applied: { dispose(): void }[] = []
  let last = ''
  const apply = (): void => {
    const rules = editorChordRules(listCommands(), keybindingOverrides())
      .map((c) => ({ ...c, keybinding: monacoKeybinding(c.chord, monaco) }))
      .filter((c) => c.keybinding)
    const sig = JSON.stringify(rules)
    if (sig === last) return
    last = sig
    applied.forEach((d) => d.dispose())
    applied = rules.map(({ command, fallback }) => monaco.editor.registerCommand(`webterm.chord.${command}`, () => {
      const cmd = listCommands().find((c) => c.id === command)
      if (cmd?.run) cmd.run()
      else if (fallback) monaco.editor.getEditors().find((e) => e.hasTextFocus())?.trigger('keyboard', fallback, null)
    }))
    applied.push(monaco.editor.addKeybindingRules(rules.map(({ keybinding, command }) => ({ keybinding, command: `webterm.chord.${command}` }))))
  }
  apply()
  const offKeys = subscribeKeybindings(apply)
  const offCommands = subscribeCommands(apply)
  return () => { offKeys(); offCommands(); applied.forEach((d) => d.dispose()); applied = [] }
}
