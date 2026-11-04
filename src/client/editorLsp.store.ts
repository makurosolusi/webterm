// What the LSP wiring (editorLsp.monaco.ts, outside React) hands to React: live diagnostics for
// the Problems panel, the rename waiting for the user's preview decision, and how to open a file
// in an editor node (App registers it; without it Go to Definition peeks in place).
import { useSyncExternalStore } from 'react'
import type { Problem } from '../server/problems/problems.parse'
import type { RenamePreviewLine } from './editorLsp.convert'

/** A language-server diagnostic as a Problems row (`source` is the server's, e.g. "ts" or "Pyright"). */
export type LspProblem = Omit<Problem, 'source'> & { source: string }

export interface RenamePreview { nodeId: string; newName: string; files: { path: string; lines: RenamePreviewLine[] }[] }

const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }

const problemsByPath = new Map<string, LspProblem[]>()
let problems: LspProblem[] = []

/** Replace the diagnostics of one file ([] clears it). */
export function setLspProblems(path: string, list: LspProblem[]): void {
  if (list.length) problemsByPath.set(path, list)
  else if (!problemsByPath.delete(path)) return
  problems = [...problemsByPath.values()].flat()
  emit()
}

export const lspProblems = (): LspProblem[] => problems
export const useLspProblems = (): LspProblem[] => useSyncExternalStore(subscribe, lspProblems)

let pending: { preview: RenamePreview; resolve(ok: boolean): void } | null = null

/** Show the rename's edits in the editor node that asked; resolves true on Apply, false on Cancel. */
export function requestRenamePreview(preview: RenamePreview): Promise<boolean> {
  pending?.resolve(false) // a newer rename replaces one still open
  return new Promise((resolve) => { pending = { preview, resolve }; emit() })
}

export function answerRenamePreview(ok: boolean): void {
  const p = pending
  if (!p) return
  pending = null
  p.resolve(ok)
  emit()
}

export const renamePreview = (): RenamePreview | null => pending?.preview ?? null
export const useRenamePreview = (nodeId: string): RenamePreview | null =>
  useSyncExternalStore(subscribe, () => (pending?.preview.nodeId === nodeId ? pending.preview : null))

export type LspFileOpener = (path: string, line: number, column: number) => void
let opener: LspFileOpener | null = null

/** App's "open this file in an editor node at a line"; returns the unregister. */
export function setLspFileOpener(fn: LspFileOpener): () => void {
  opener = fn
  return () => { if (opener === fn) opener = null }
}

export const lspFileOpener = (): LspFileOpener | null => opener
