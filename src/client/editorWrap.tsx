// Word wrap for editor and diff nodes, like VS Code's View: Toggle Word Wrap (⌥Z / Alt+Z): on by
// default for prose (Markdown, plain text), off for code; the user's choice lives on the node.
import { useEffect, useRef } from 'react'
import type * as Monaco from 'monaco-editor'
import { ToolbarButton } from '@/vscode/register'
import { fileBaseName, fileExt } from './editorFile'
import { chordLabel, useCommands } from './commandRegistry'
import { monacoKeybinding } from './editorChords'
import { useKeybindingOverrides } from './keybindings.store'
import { commandKey } from './keybindings.resolve'
import { isMacPlatform } from './terminalKeys.platform'

const PROSE_EXTS = new Set(['', 'md', 'markdown', 'mdx', 'txt'])
const BUILD_FILES = new Set(['dockerfile', 'makefile', 'procfile', 'justfile'])
const WRAP_ACTION_ID = 'webterm.editor.toggleWordWrap'
/** Registry command (`commandRegistry.defaults`), default ⌥Z / Alt+Z; rebindable. */
export const WRAP_COMMAND_ID = 'editor.toggleWordWrap'

/** Wrap when the node has no stored choice: prose and extension-less text wrap; dotfiles and build files do not. */
export function wrapByDefault(filePath: string): boolean {
  const name = fileBaseName(filePath)
  if (name.startsWith('.') || BUILD_FILES.has(name.toLowerCase())) return false
  return PROSE_EXTS.has(fileExt(filePath))
}

/** The node's stored `wordWrap` when it is a boolean, else the default for its file. */
export const effectiveWrap = (stored: unknown, filePath: string): boolean =>
  typeof stored === 'boolean' ? stored : wrapByDefault(filePath)

/** Live chord of Toggle Word Wrap (follows a rebinding); undefined when unbound. */
export function useWrapChord(): string | undefined {
  return commandKey(WRAP_COMMAND_ID, useCommands(), useKeybindingOverrides())
}

/** Chord text shown in the toolbar title ('' when unbound). */
export const wrapChordLabel = (chord: string | undefined): string => (chord ? chordLabel(chord, isMacPlatform()) : '')

/** A live Monaco surface: `options` takes the wrap option, `code` are the editors that own the chord. */
export interface WrapTarget {
  monaco: Pick<typeof Monaco, 'KeyMod' | 'KeyCode'>
  options: { updateOptions(o: { wordWrap: 'on' | 'off' }): void }
  code: Pick<Monaco.editor.IStandaloneCodeEditor, 'addAction'>[]
}

/** Applies `on` live (no remount) and binds the Toggle Word Wrap chord on `target`'s own editors only. */
export function useWordWrap(target: WrapTarget | null, on: boolean, toggle: () => void): void {
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  const chord = useWrapChord()
  useEffect(() => { target?.options.updateOptions({ wordWrap: on ? 'on' : 'off' }) }, [target, on])
  useEffect(() => {
    if (!target) return
    const kb = chord ? monacoKeybinding(chord, target.monaco) : 0
    // An action's keybinding is scoped to its editor, so the chord never flips another node.
    // Re-added when the chord is rebound; unbound keeps the action (no keybinding).
    const subs = target.code.map((e) => e.addAction({ id: WRAP_ACTION_ID, label: 'View: Toggle Word Wrap', keybindings: kb ? [kb] : [], run: () => toggleRef.current() }))
    return () => subs.forEach((s) => s.dispose())
  }, [target, chord])
}

/** Header toggle; pressed while wrap is on. */
export function WordWrapButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const key = wrapChordLabel(useWrapChord())
  const title = key ? `Toggle word wrap (${key})` : 'Toggle word wrap'
  return (
    <ToolbarButton label="Word wrap" title={title} data-title={title} toggleable checked={on} onClick={onToggle}>
      <span className="codicon codicon-word-wrap" aria-hidden="true" />
    </ToolbarButton>
  )
}
