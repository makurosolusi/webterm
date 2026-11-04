// Monaco `createDiffEditor` for the Diff node: HEAD (left) vs working tree (right), read-only, the
// way Orca `DiffSectionItem.tsx` mounts it. Lazily loaded through `loadMonaco` like the editor node.
// Reports the cursor line of the modified side (where a new note goes) and highlights noted lines.
import { useEffect, useRef, useState, type RefObject } from 'react'
import type * as Monaco from 'monaco-editor'
import { loadMonaco } from './lazyMonaco'
import { currentMonacoTheme } from './monacoTheme'

/** Model URIs must be unique per Monaco instance: two Diff nodes on one file would collide. */
let modelSeq = 0

export interface DiffSides { path: string; original: string; modified: string }

export function useDiffEditor(host: RefObject<HTMLDivElement | null>, sides: DiffSides | null, notedLines: readonly number[]): { line: number; error: string } {
  const decoRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)
  const [line, setLine] = useState(1)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(0) // bumps once the async editor exists, so decorations apply

  useEffect(() => {
    const el = host.current
    if (!el || !sides) return
    let disposed = false
    let cleanup = () => {}
    loadMonaco().then((m) => {
      if (disposed) return
      const seq = ++modelSeq
      const original = m.editor.createModel(sides.original, undefined, m.Uri.parse(`inmemory://diff/${seq}/head/${sides.path}`))
      const modified = m.editor.createModel(sides.modified, undefined, m.Uri.parse(`inmemory://diff/${seq}/work/${sides.path}`))
      const editor = m.editor.createDiffEditor(el, {
        automaticLayout: true, readOnly: true, originalEditable: false, minimap: { enabled: false },
        scrollBeyondLastLine: false, renderSideBySide: true, useInlineViewWhenSpaceIsLimited: true, theme: currentMonacoTheme(),
      })
      editor.setModel({ original, modified })
      decoRef.current = editor.getModifiedEditor().createDecorationsCollection()
      setReady((n) => n + 1)
      const sub = editor.getModifiedEditor().onDidChangeCursorPosition((e) => setLine(e.position.lineNumber))
      cleanup = () => { sub.dispose(); editor.dispose(); original.dispose(); modified.dispose(); decoRef.current = null }
    }, (e: unknown) => setError(`Could not load the diff editor: ${e instanceof Error ? e.message : String(e)}`))
    return () => { disposed = true; cleanup() }
  }, [host, sides])

  useEffect(() => {
    decoRef.current?.set(notedLines.filter((l) => l > 0).map((l) => ({
      range: { startLineNumber: l, startColumn: 1, endLineNumber: l, endColumn: 1 },
      options: { isWholeLine: true, className: 'diff-node__noted-line', glyphMarginHoverMessage: { value: 'Review note' } },
    })))
  }, [notedLines, ready])

  return { line, error }
}
