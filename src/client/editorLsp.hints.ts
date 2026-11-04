// "No language server" hints per Monaco language id, for the editor node banner. Set by the LSP
// wiring when the server answers `lsp-unavailable`; cleared once a server is up or the user dismisses.
import { useSyncExternalStore } from 'react'
import type { LspHint } from './editorLsp.client'

const hints = new Map<string, LspHint>()
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

/** Monaco language ids one server covers (the TS server also serves JS). */
export const LSP_LANGUAGE_IDS = { typescript: ['typescript', 'javascript'], python: ['python'] } as const
export type ServerLanguage = keyof typeof LSP_LANGUAGE_IDS

export function setLspHint(lang: ServerLanguage, hint: LspHint | null): void {
  for (const id of LSP_LANGUAGE_IDS[lang]) if (hint) hints.set(id, hint); else hints.delete(id)
  emit()
}

export function dismissLspHint(languageId: string): void {
  hints.delete(languageId)
  emit()
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }

const EXT_LANGUAGE: Record<string, string> = { ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python' }
/** Monaco language id for a file extension the LSP wiring serves ('' = none). */
export const lspLanguageIdForExt = (ext: string): string => EXT_LANGUAGE[ext.replace(/^\./, '').toLowerCase()] ?? ''

export const lspHint = (languageId: string): LspHint | null => hints.get(languageId) ?? null

/** Hint for a Monaco language id ('' = none), re-rendering when it changes. */
export function useLspHint(languageId: string): LspHint | null {
  return useSyncExternalStore(subscribe, () => lspHint(languageId))
}
