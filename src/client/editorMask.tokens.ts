// Per-value reveal in the masked editor: masked tokens get a "Reveal" hover and a click reveals that one.
// File-wide masks have no tokens (a stray click must not show a whole key file): "Reveal all" only.
import { useEffect, useLayoutEffect } from 'react'
import type { editor as MonacoEditor } from 'monaco-editor'
import type { SecretScan } from '../shared/secretMask.detect'
import { isRevealed, rangeAtOffset, type RevealState } from './secretMask.reveal'

export const MASK_TOKEN_CLASS = 'webterm-secret-token'

export function useMaskTokens(
  ed: MonacoEditor.IStandaloneCodeEditor | null, mode: string, scan: SecretScan,
  state: RevealState, onReveal: (index: number) => void,
): void {
  const active = !!ed && mode === 'masked' && !scan.fileWide
  // Declared after the hook's text swap: `model.setValue` destroys decorations, so they are rebuilt each time.
  useLayoutEffect(() => {
    if (!active || !ed) return
    const model = ed.getModel()
    if (!model) return
    const coll = ed.createDecorationsCollection(
      scan.ranges.flatMap((r, i) => {
        if (isRevealed(state, i)) return []
        const a = model.getPositionAt(r.from)
        const b = model.getPositionAt(r.to)
        return [{
          range: { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column },
          options: { inlineClassName: MASK_TOKEN_CLASS, hoverMessage: { value: 'Reveal (click)' } },
        }]
      }),
    )
    return () => coll.clear()
  }, [active, ed, scan, state])
  useEffect(() => {
    if (!active || !ed) return
    const sub = ed.onMouseDown((e) => {
      const model = ed.getModel()
      if (!model || !e.target.position) return
      const i = rangeAtOffset(scan, model.getOffsetAt(e.target.position))
      if (i >= 0 && !isRevealed(state, i)) onReveal(i)
    })
    return () => sub.dispose()
  }, [active, ed, scan, state, onReveal])
}
