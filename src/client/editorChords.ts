// Monaco handles a keydown it has a binding for and stops it, so the window command dispatcher never
// sees it: Mod+Shift+L is "Select All Occurrences" and Mod+Shift+[ / ] are fold / unfold. Like
// `terminalKeys` does for xterm, hand the tab-layout chords back to the command registry. Registered
// once from `lazyMonaco`, through the public `addKeybindingRules` API (a later binding for the same
// chord overrides Monaco's built-in one). Keybindings are global in Monaco (one shared service), so
// they are registered once at load rather than per editor: an editor's `addCommand` is not even usable
// from `onDidCreateEditor`, which fires before the editor's keybinding service is set.
import type * as Monaco from 'monaco-editor'
import { listCommands } from './commandRegistry'
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

/** Monaco keybinding number for a registry chord of the shape `Mod+Shift+<letter | [ | ]>`. */
export function monacoKeybinding(chord: string, { KeyMod, KeyCode }: MonacoKeys): number {
  const parts = chord.split('+')
  const key = parts.pop() ?? ''
  const mods: Record<string, number> = { Mod: KeyMod.CtrlCmd, Shift: KeyMod.Shift, Alt: KeyMod.Alt }
  const code = key === '[' ? KeyCode.BracketLeft : key === ']' ? KeyCode.BracketRight : KeyCode[`Key${key}` as keyof typeof KeyCode]
  return parts.reduce((bits, mod) => bits | mods[mod], code)
}

type ChordApi = MonacoKeys & { editor: Pick<typeof Monaco.editor, 'addKeybindingRules' | 'registerCommand' | 'getEditors'> }

/** Pass the tab-layout chords through every Monaco editor to the command registry. */
export function forwardTabChords(monaco: ChordApi): void {
  monaco.editor.addKeybindingRules(EDITOR_CHORDS.map(({ chord, command, fallback }) => {
    const id = `webterm.chord.${command}`
    monaco.editor.registerCommand(id, () => {
      const cmd = listCommands().find((c) => c.id === command)
      if (cmd?.run) cmd.run()
      else if (fallback) monaco.editor.getEditors().find((e) => e.hasTextFocus())?.trigger('keyboard', fallback, null)
    })
    return { keybinding: monacoKeybinding(chord, monaco), command: id }
  }))
}
