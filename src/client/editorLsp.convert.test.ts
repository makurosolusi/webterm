// Pure LSP <-> Monaco shape conversions (editorLsp.convert.ts).
import { describe, expect, it } from 'vitest'
import { applyTextEdits, renamePreviewLines, toCompletion, toDocumentSymbols, toHover, toLocations, toSignatureHelp } from './editorLsp.convert'

describe('editorLsp.convert', () => {
  it('applyTextEdits applies non-overlapping edits by position, end first', () => {
    const r = (l: number, c: number, l2: number, c2: number) => ({ start: { line: l, character: c }, end: { line: l2, character: c2 } })
    expect(applyTextEdits('ab\ncd\n', [{ range: r(0, 0, 0, 1), newText: 'X' }, { range: r(1, 1, 1, 2), newText: 'YY' }])).toBe('Xb\ncYY\n')
  })
  it('converts LocationLink, MarkedString hovers and completion items', () => {
    expect(toLocations({ uri: 'file:///a', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } })).toHaveLength(1)
    expect(toHover({ contents: [{ language: 'ts', value: 'x' }, ''] })).toEqual({ contents: [{ value: '```ts\nx\n```' }] })
    const m = { languages: { CompletionItemKind: { Function: 1, Text: 18 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 } } }
    const wr = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }
    expect(toCompletion(m as never, { label: 'f', kind: 3, insertText: 'f($1)', insertTextFormat: 2 }, wr)).toEqual({ label: 'f', kind: 1, insertText: 'f($1)', insertTextRules: 4, range: wr })
  })
  it('renamePreviewLines groups edits per line; flat SymbolInformation and empty signature help', () => {
    const r = (l: number, c: number, c2: number) => ({ start: { line: l, character: c }, end: { line: l, character: c2 } })
    expect(renamePreviewLines('a + a\nb\na', [{ range: r(2, 0, 1), newText: 'z' }, { range: r(0, 4, 5), newText: 'z' }, { range: r(0, 0, 1), newText: 'z' }]))
      .toEqual([{ line: 1, before: 'a + a', after: 'z + z' }, { line: 3, before: 'a', after: 'z' }])
    expect(toDocumentSymbols([{ name: 'f', kind: 12, containerName: 'm', location: { uri: 'file:///a', range: r(0, 0, 1) } }]))
      .toEqual([{ name: 'f', detail: '', kind: 11, tags: [], containerName: 'm', range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, selectionRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 } }])
    expect(toSignatureHelp({ signatures: [] })).toBeNull()
  })
})
