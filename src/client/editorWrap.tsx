// Word wrap for editor and diff nodes, like VS Code's View: Toggle Word Wrap (⌥Z / Alt+Z): on by
// default for prose (Markdown, plain text), off for code; the user's choice lives on the node.
import { useEffect, useRef } from 'react'
import type * as Monaco from 'monaco-editor'
import { ToolbarButton } from '@/vscode/register'
import { fileBaseName, fileExt } from './editorFile'
import { isMacPlatform } from './terminalKeys.platform'

const PROSE_EXTS = new Set(['', 'md', 'markdown', 'mdx', 'txt'])
const BUILD_FILES = new Set(['dockerfile', 'makefile', 'procfile', 'justfile'])
const WRAP_ACTION_ID = 'webterm.editor.toggleWordWrap'

/** Wrap when the node has no stored choice: prose and extension-less text wrap; dotfiles and build files do not. */
export function wrapByDefault(filePath: string): boolean {
  const name = fileBaseName(filePath)
  if (name.startsWith('.') || BUILD_FILES.has(name.toLowerCase())) return false
  return PROSE_EXTS.has(fileExt(filePath))
}

/** The node's stored `wordWrap` when it is a boolean, else the default for its file. */
export const effectiveWrap = (stored: unknown, filePath: string): boolean =>
  typeof stored === 'boolean' ? stored : wrapByDefault(filePath)

/** Chord text shown in the toolbar title. */
export const wrapChordLabel = (): string => (isMacPlatform() ? '⌥Z' : 'Alt+Z')

/** A live Monaco surface: `options` takes the wrap option, `code` are the editors that own the chord. */
export interface WrapTarget {
  monaco: Pick<typeof Monaco, 'KeyMod' | 'KeyCode'>
  options: { updateOptions(o: { wordWrap: 'on' | 'off' }): void }
  code: Pick<Monaco.editor.IStandaloneCodeEditor, 'addAction'>[]
}

/** Applies `on` live (no remount) and binds Alt+Z on `target`'s own editors only. */
export function useWordWrap(target: WrapTarget | null, on: boolean, toggle: () => void): void {
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  useEffect(() => { target?.options.updateOptions({ wordWrap: on ? 'on' : 'off' }) }, [target, on])
  useEffect(() => {
    if (!target) return
    const { KeyMod, KeyCode } = target.monaco
    // An action's keybinding is scoped to its editor, so the chord never flips another node.
    const subs = target.code.map((e) => e.addAction({ id: WRAP_ACTION_ID, label: 'View: Toggle Word Wrap', keybindings: [KeyMod.Alt | KeyCode.KeyZ], run: () => toggleRef.current() }))
    return () => subs.forEach((s) => s.dispose())
  }, [target])
}

/** Header toggle; pressed while wrap is on. */
export function WordWrapButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const title = `Toggle word wrap (${wrapChordLabel()})`
  return (
    <ToolbarButton label="Word wrap" title={title} data-title={title} toggleable checked={on} onClick={onToggle}>
      <span className="codicon codicon-word-wrap" aria-hidden="true" />
    </ToolbarButton>
  )
}
