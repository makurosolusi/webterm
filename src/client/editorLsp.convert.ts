// LSP (0-based line/character, UTF-16) <-> Monaco (1-based lineNumber/column, UTF-16) shapes.
// Only the LSP fields the editor uses are typed; see the LSP 3.17 spec for the full ones.
import type * as Monaco from 'monaco-editor'

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspLocation { uri: string; range: LspRange }
export interface LspLocationLink { targetUri: string; targetRange: LspRange; targetSelectionRange?: LspRange }
export interface LspTextEdit { range: LspRange; newText: string }
export interface LspDiagnostic { range: LspRange; message: string; severity?: number; source?: string; code?: string | number }
type MarkedString = string | { language: string; value: string }
export interface LspHover { contents: MarkedString | MarkedString[] | { kind: string; value: string }; range?: LspRange }
export interface LspCompletionItem {
  label: string | { label: string }
  kind?: number
  detail?: string
  documentation?: string | { kind: string; value: string }
  insertText?: string
  insertTextFormat?: number
  textEdit?: LspTextEdit | { newText: string; insert: LspRange; replace: LspRange }
  filterText?: string
  sortText?: string
}
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>
  documentChanges?: ({ textDocument: { uri: string }; edits: LspTextEdit[] } | { kind: string })[]
}

export const toLspPosition = (p: Monaco.IPosition): LspPosition => ({ line: p.lineNumber - 1, character: p.column - 1 })
export const toRange = (r: LspRange): Monaco.IRange => ({
  startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1,
})

/** LSP DiagnosticSeverity 1..4 -> Monaco MarkerSeverity (Error 8, Warning 4, Info 2, Hint 1). */
const SEVERITY: Record<number, number> = { 1: 8, 2: 4, 3: 2, 4: 1 }
export const toMarker = (d: LspDiagnostic): Monaco.editor.IMarkerData => ({
  ...toRange(d.range), message: d.message, severity: SEVERITY[d.severity ?? 1] ?? 8,
  ...(d.source ? { source: d.source } : {}), ...(d.code !== undefined ? { code: String(d.code) } : {}),
})

const markdown = (m: MarkedString | { kind: string; value: string }): Monaco.IMarkdownString =>
  typeof m === 'string' ? { value: m } : 'language' in m ? { value: `\`\`\`${m.language}\n${m.value}\n\`\`\`` } : { value: m.value }

export function toHover(h: LspHover | null): Monaco.languages.Hover | null {
  if (!h) return null
  const contents = (Array.isArray(h.contents) ? h.contents : [h.contents]).map(markdown).filter((c) => c.value !== '')
  return contents.length ? { contents, ...(h.range ? { range: toRange(h.range) } : {}) } : null
}

/** Location | Location[] | LocationLink[] | null -> one list. */
export function toLocations(r: LspLocation | LspLocation[] | LspLocationLink[] | null): LspLocation[] {
  if (!r) return []
  return (Array.isArray(r) ? r : [r]).map((l) => ('targetUri' in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l))
}

/** LSP CompletionItemKind (1..25) -> Monaco CompletionItemKind names. */
const KIND = ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'] as const

export function toCompletion(m: typeof Monaco, item: LspCompletionItem, wordRange: Monaco.IRange): Monaco.languages.CompletionItem {
  const label = typeof item.label === 'string' ? item.label : item.label.label
  const te = item.textEdit
  const range = !te ? wordRange : 'range' in te ? toRange(te.range) : { insert: toRange(te.insert), replace: toRange(te.replace) }
  const doc = item.documentation
  return {
    label,
    kind: m.languages.CompletionItemKind[KIND[(item.kind ?? 1) - 1] ?? 'Text'],
    insertText: te?.newText ?? item.insertText ?? label,
    ...(item.insertTextFormat === 2 ? { insertTextRules: m.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
    range,
    ...(item.detail ? { detail: item.detail } : {}),
    ...(doc ? { documentation: typeof doc === 'string' ? doc : { value: doc.value } } : {}),
    ...(item.filterText ? { filterText: item.filterText } : {}),
    ...(item.sortText ? { sortText: item.sortText } : {}),
  }
}

/** WorkspaceEdit -> edits per file uri (create/rename/delete file ops are not applied). */
export function workspaceEdits(e: LspWorkspaceEdit | null): Map<string, LspTextEdit[]> {
  const out = new Map<string, LspTextEdit[]>()
  if (!e) return out
  for (const [uri, edits] of Object.entries(e.changes ?? {})) out.set(uri, edits)
  for (const dc of e.documentChanges ?? []) if ('textDocument' in dc) out.set(dc.textDocument.uri, [...(out.get(dc.textDocument.uri) ?? []), ...dc.edits])
  return out
}

/** Apply LSP edits to text (a file not open in any editor). Edits are non-overlapping per spec. */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  const off = (p: LspPosition) => Math.min((starts[p.line] ?? text.length) + p.character, text.length)
  return [...edits]
    .sort((a, b) => off(b.range.start) - off(a.range.start))
    .reduce((t, e) => t.slice(0, off(e.range.start)) + e.newText + t.slice(off(e.range.end)), text)
}

type LspDoc = string | { kind: string; value: string }
const doc = (d: LspDoc | undefined): string | Monaco.IMarkdownString | undefined => (d === undefined || typeof d === 'string' ? d : { value: d.value })

export interface LspSignatureHelp {
  signatures: { label: string; documentation?: LspDoc; parameters?: { label: string | [number, number]; documentation?: LspDoc }[]; activeParameter?: number }[]
  activeSignature?: number
  activeParameter?: number
}

/** SignatureHelp -> Monaco's (same shape; documentation becomes markdown, missing indexes 0). */
export function toSignatureHelp(h: LspSignatureHelp | null): Monaco.languages.SignatureHelp | null {
  if (!h?.signatures?.length) return null
  return {
    activeSignature: h.activeSignature ?? 0,
    activeParameter: h.activeParameter ?? 0,
    signatures: h.signatures.map((s) => ({
      label: s.label,
      ...(s.documentation !== undefined ? { documentation: doc(s.documentation) } : {}),
      parameters: (s.parameters ?? []).map((p) => ({ label: p.label, ...(p.documentation !== undefined ? { documentation: doc(p.documentation) } : {}) })),
      ...(s.activeParameter !== undefined ? { activeParameter: s.activeParameter } : {}),
    })),
  }
}

export interface LspDocumentSymbol { name: string; detail?: string; kind: number; tags?: number[]; range: LspRange; selectionRange: LspRange; children?: LspDocumentSymbol[] }
export interface LspSymbolInformation { name: string; kind: number; tags?: number[]; containerName?: string; location: LspLocation }

/** DocumentSymbol[] (tree) or SymbolInformation[] (flat) -> Monaco DocumentSymbol tree. LSP SymbolKind is Monaco's + 1. */
export function toDocumentSymbols(r: (LspDocumentSymbol | LspSymbolInformation)[] | null): Monaco.languages.DocumentSymbol[] {
  const one = (s: LspDocumentSymbol | LspSymbolInformation): Monaco.languages.DocumentSymbol => {
    const tree = 'range' in s
    const range = toRange(tree ? s.range : s.location.range)
    return {
      name: s.name, detail: tree ? s.detail ?? '' : '', kind: s.kind - 1, tags: s.tags ?? [], range,
      selectionRange: tree ? toRange(s.selectionRange) : range,
      ...(!tree && s.containerName ? { containerName: s.containerName } : {}),
      ...(tree && s.children?.length ? { children: s.children.map(one) } : {}),
    }
  }
  return (r ?? []).map(one)
}

export interface RenamePreviewLine { line: number; before: string; after: string }

/** Lines a rename touches in `text`, before and after. ponytail: each single-line edit's line only (rename edits are single-line). */
export function renamePreviewLines(text: string, edits: LspTextEdit[]): RenamePreviewLine[] {
  const lines = text.split('\n')
  const byLine = new Map<number, LspTextEdit[]>()
  for (const e of edits) if (e.range.start.line === e.range.end.line) byLine.set(e.range.start.line, [...(byLine.get(e.range.start.line) ?? []), e])
  const at0 = (p: LspPosition): LspPosition => ({ line: 0, character: p.character })
  return [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([l, es]) => {
    const before = lines[l] ?? ''
    return { line: l + 1, before, after: applyTextEdits(before, es.map((e) => ({ newText: e.newText, range: { start: at0(e.range.start), end: at0(e.range.end) } }))) }
  })
}
