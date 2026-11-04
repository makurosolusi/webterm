// LSP wiring against a fake Monaco + fake WebSocket: which models join a session, what goes on
// the wire, and what the providers hand back to Monaco.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_CAPS, setup, Uri } from './editorLsp.fake'
import { LSP_CLOSE as SERVER_CLOSE, LSP_UNAVAILABLE as SERVER_UNAVAILABLE, LSP_WS_PATH as SERVER_PATH } from '../server/lsp/lsp.contract'
import { LSP_UNAVAILABLE, LSP_WS_PATH } from './editorLsp.client'
import { lspHint, setLspHint } from './editorLsp.hints'
import { answerRenamePreview, lspProblems, renamePreview, setLspFileOpener } from './editorLsp.store'

afterEach(() => { setLspHint('typescript', null); setLspHint('python', null); answerRenamePreview(false) })

describe('wireEditorLsp', () => {
  it('pins the wire constants to the server contract', () => {
    expect(LSP_WS_PATH).toBe(SERVER_PATH)
    expect(LSP_UNAVAILABLE).toBe(SERVER_UNAVAILABLE)
  })

  it('registers hover/completion/definition/references/rename/signature help/symbols for ts, js and python', () => {
    const { providers } = setup()
    for (const lang of ['typescript', 'javascript', 'python']) expect(Object.keys(providers[lang]!).sort()).toEqual(['completion', 'definition', 'hover', 'references', 'rename', 'signature', 'symbols'])
  })

  it('a ts node model opens one socket; initialize goes first, didOpen after the handshake; js joins the same server', async () => {
    const t = setup()
    t.nodeModel('/w/a.ts', 'let a')
    expect(t.sockets.map((x) => [x.ws, x.lang])).toEqual([['w1', 'typescript']])
    const s = t.sockets[0]!.s
    s.open()
    expect(s.methods()).toEqual(['initialize'])
    s.reply('initialize', { capabilities: {} })
    expect(s.methods()).toEqual(['initialize', 'initialized', 'textDocument/didOpen'])
    expect(s.sent[2].params.textDocument).toEqual({ uri: 'file:///w/a.ts', languageId: 'typescript', version: 1, text: 'let a' })
    t.nodeModel('/w/b.js', 'b')
    expect(t.sockets).toHaveLength(1)
    expect(s.sent.at(-1).params.textDocument.languageId).toBe('javascript')
  })

  it('ignores models that are not editor nodes (no fragment) and models before a workspace is known', () => {
    const t = setup()
    t.model(Uri.file('/w/peek.ts'), 'x')
    expect(t.sockets).toHaveLength(0)
    const t2 = setup({ workspaceId: () => '' })
    t2.nodeModel('/w/a.ts')
    expect(t2.sockets).toHaveLength(0)
  })

  it('syncs full text with rising versions; two nodes on one file share one didOpen; the last close sends didClose and closes the socket', async () => {
    const t = setup()
    const a = t.nodeModel('/w/a.ts', 'one', 'n1')
    const b = t.nodeModel('/w/a.ts', 'one', 'n2')
    const s = t.sockets[0]!.s
    await t.live(s)
    expect(s.methods().filter((x) => x === 'textDocument/didOpen')).toHaveLength(1)
    a.setText('two')
    expect(s.sent.at(-1)).toMatchObject({ method: 'textDocument/didChange', params: { textDocument: { uri: 'file:///w/a.ts', version: 2 }, contentChanges: [{ text: 'two' }] } })
    a.dispose()
    expect(s.methods()).not.toContain('textDocument/didClose')
    b.dispose()
    expect(s.methods().at(-1)).toBe('textDocument/didClose')
    expect(s.closed).toBe(true)
  })

  it('publishDiagnostics become Monaco markers on every node model of that file', async () => {
    const t = setup()
    const a = t.nodeModel('/w/a.ts')
    await t.live(t.sockets[0]!.s)
    t.sockets[0]!.s.push({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///w/a.ts', diagnostics: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, message: 'bad', severity: 2, source: 'ts' }] } })
    expect(t.markers.get(a)).toEqual([{ startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 6, message: 'bad', severity: 4, source: 'ts' }])
  })

  it('hover asks the server once live (null before) and steps the built-in TS worker back while live', async () => {
    const t = setup()
    const a = t.nodeModel('/w/a.ts')
    const s = t.sockets[0]!.s
    expect(await t.providers.typescript!.hover.provideHover(a, { lineNumber: 1, column: 1 })).toBeNull()
    await t.live(s)
    expect(t.m.typescript.typescriptDefaults.modeConfiguration).toMatchObject({ hovers: false, completionItems: false, definitions: false, rename: false, diagnostics: false })
    const p = t.providers.typescript!.hover.provideHover(a, { lineNumber: 3, column: 5 })
    expect(s.sent.at(-1)).toMatchObject({ method: 'textDocument/hover', params: { textDocument: { uri: 'file:///w/a.ts' }, position: { line: 2, character: 4 } } })
    s.reply('textDocument/hover', { contents: { kind: 'markdown', value: '**x**' } })
    expect(await p).toEqual({ contents: [{ value: '**x**' }] })
    a.dispose()
    expect(t.m.typescript.typescriptDefaults.modeConfiguration).toMatchObject({ hovers: true, diagnostics: true })
  })

  it('a server without signatureHelpProvider leaves Monaco built-in signature help on and its provider silent', async () => {
    const t = setup()
    const a = t.nodeModel('/w/a.ts')
    const s = t.sockets[0]!.s
    const { signatureHelpProvider: _omit, ...caps } = ALL_CAPS
    await t.live(s, caps)
    expect(t.m.typescript.typescriptDefaults.modeConfiguration).toMatchObject({ signatureHelp: true, hovers: false, documentSymbols: false, diagnostics: false })
    const sent = s.sent.length
    expect(await t.providers.typescript!.signature.provideSignatureHelp(a, { lineNumber: 1, column: 1 }, null, { triggerKind: 1, isRetrigger: false })).toBeNull()
    expect(s.sent).toHaveLength(sent) // nothing asked of a server that cannot answer
  })

  it('a server with no capabilities keeps every built-in except diagnostics', async () => {
    const t = setup()
    t.nodeModel('/w/a.ts')
    await t.live(t.sockets[0]!.s, {})
    expect(t.m.typescript.typescriptDefaults.modeConfiguration).toMatchObject({ completionItems: true, hovers: true, definitions: true, references: true, rename: true, signatureHelp: true, documentSymbols: true, diagnostics: false })
  })

  it('definition into a file no editor holds loads a read-only peek model', async () => {
    const t = setup()
    const a = t.nodeModel('/w/a.ts')
    const s = t.sockets[0]!.s
    await t.live(s)
    const p = t.providers.typescript!.definition.provideDefinition(a, { lineNumber: 1, column: 1 })
    s.reply('textDocument/definition', [{ targetUri: 'file:///w/lib.ts', targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }])
    const locs = await p
    expect(locs[0].uri.toString()).toBe('file:///w/lib.ts')
    expect(t.deps.readMeta).toHaveBeenCalledWith('/w/lib.ts')
    expect(t.m.editor.getModel(Uri.file('/w/lib.ts'))?.getValue()).toContain('const a')
  })

  it('rename edits open node models in place and writes other files to disk version-checked', async () => {
    const t = setup()
    const a = t.nodeModel('/w/a.ts', 'const a = 2')
    const s = t.sockets[0]!.s
    await t.live(s)
    const p = t.providers.typescript!.rename.provideRenameEdits(a, { lineNumber: 1, column: 7 }, 'z')
    const r = (l: number, c: number) => ({ start: { line: l, character: c }, end: { line: l, character: c + 1 } })
    s.reply('textDocument/rename', { changes: { 'file:///w/a.ts': [{ range: r(0, 6), newText: 'z' }], 'file:///w/other.ts': [{ range: r(0, 6), newText: 'z' }, { range: r(1, 10), newText: 'z' }] } })
    await vi.waitFor(() => expect(renamePreview()).not.toBeNull())
    expect(t.deps.writeChecked).not.toHaveBeenCalled() // nothing is written before Apply
    expect(renamePreview()).toEqual({ nodeId: 'n1', newName: 'z', files: [
      { path: '/w/a.ts', lines: [{ line: 1, before: 'const a = 2', after: 'const z = 2' }] },
      { path: '/w/other.ts', lines: [{ line: 1, before: 'const a = 1', after: 'const z = 1' }, { line: 2, before: 'const b = a', after: 'const b = z' }] },
    ] })
    answerRenamePreview(true)
    const res = await p
    expect(res.edits).toEqual([{ resource: a.uri, textEdit: { range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 8 }, text: 'z' }, versionId: undefined }])
    expect(t.deps.writeChecked).toHaveBeenCalledWith('/w/other.ts', 'const z = 1\nconst b = z\n', { expectedVersion: 'v1', mustExist: true })
  })

  it('a failed disk write rejects the whole rename with the file named', async () => {
    const t = setup({ writeChecked: vi.fn(async () => ({ ok: false as const, code: 'EVERSION' as const, error: 'changed on disk' })) })
    const a = t.nodeModel('/w/a.ts')
    const s = t.sockets[0]!.s
    await t.live(s)
    const p = t.providers.typescript!.rename.provideRenameEdits(a, { lineNumber: 1, column: 7 }, 'z')
    s.reply('textDocument/rename', { changes: { 'file:///w/other.ts': [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: 'z' }] } })
    await vi.waitFor(() => expect(renamePreview()).not.toBeNull())
    answerRenamePreview(true)
    expect(await p).toEqual({ edits: [], rejectReason: 'Rename could not update /w/other.ts: changed on disk' })
  })

  it('cancelling the rename preview writes nothing and edits nothing', async () => {
    const t = setup()
    const a = t.nodeModel('/w/a.ts', 'const a = 1')
    const s = t.sockets[0]!.s
    await t.live(s)
    const p = t.providers.typescript!.rename.provideRenameEdits(a, { lineNumber: 1, column: 7 }, 'z')
    s.reply('textDocument/rename', { changes: { 'file:///w/other.ts': [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: 'z' }] } })
    await vi.waitFor(() => expect(renamePreview()?.files.map((f) => f.path)).toEqual(['/w/other.ts']))
    answerRenamePreview(false)
    expect(await p).toEqual({ edits: [], rejectReason: 'Rename cancelled.' })
    expect(t.deps.writeChecked).not.toHaveBeenCalled()
  })

  it('a non-UTF-8 file in a rename rejects it before any preview', async () => {
    const t = setup({ readMeta: vi.fn(async () => ({ content: '', version: 'v1', encoding: 'binary' as const })) })
    const a = t.nodeModel('/w/a.ts')
    const s = t.sockets[0]!.s
    await t.live(s)
    const p = t.providers.typescript!.rename.provideRenameEdits(a, { lineNumber: 1, column: 1 }, 'z')
    s.reply('textDocument/rename', { changes: { 'file:///w/bin.ts': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'z' }] } })
    expect(await p).toEqual({ edits: [], rejectReason: 'Rename could not update /w/bin.ts: not a UTF-8 text file' })
    expect(renamePreview()).toBeNull()
  })

  it('signature help sends the trigger context and maps the active signature/parameter', async () => {
    const t = setup()
    const a = t.nodeModel('/w/a.ts')
    const s = t.sockets[0]!.s
    await t.live(s)
    const sig = t.providers.typescript!.signature
    expect(sig.signatureHelpTriggerCharacters).toEqual(['(', ','])
    const p = sig.provideSignatureHelp(a, { lineNumber: 2, column: 4 }, null, { triggerKind: 2, triggerCharacter: '(', isRetrigger: false })
    expect(s.sent.at(-1)).toMatchObject({ method: 'textDocument/signatureHelp', params: { position: { line: 1, character: 3 }, context: { triggerKind: 2, triggerCharacter: '(', isRetrigger: false } } })
    s.reply('textDocument/signatureHelp', { signatures: [{ label: 'f(a: number, b: string): void', documentation: { kind: 'markdown', value: 'Does f' }, parameters: [{ label: [2, 11] }, { label: 'b: string' }] }], activeParameter: 1 })
    const r = await p
    expect(r.value).toEqual({ activeSignature: 0, activeParameter: 1, signatures: [{ label: 'f(a: number, b: string): void', documentation: { value: 'Does f' }, parameters: [{ label: [2, 11] }, { label: 'b: string' }] }] })
  })

  it('document symbols map the LSP tree to Monaco symbols (kind is LSP kind - 1)', async () => {
    const t = setup()
    const a = t.nodeModel('/w/a.ts')
    const s = t.sockets[0]!.s
    await t.live(s)
    const p = t.providers.typescript!.symbols.provideDocumentSymbols(a)
    expect(s.sent.at(-1)).toMatchObject({ method: 'textDocument/documentSymbol', params: { textDocument: { uri: 'file:///w/a.ts' } } })
    const r = (l: number) => ({ start: { line: l, character: 0 }, end: { line: l, character: 4 } })
    s.reply('textDocument/documentSymbol', [{ name: 'Foo', kind: 5, range: r(0), selectionRange: r(0), children: [{ name: 'bar', detail: '()', kind: 6, range: r(1), selectionRange: r(1) }] }])
    const rng = (l: number) => ({ startLineNumber: l, startColumn: 1, endLineNumber: l, endColumn: 5 })
    expect(await p).toEqual([{ name: 'Foo', detail: '', kind: 4, tags: [], range: rng(1), selectionRange: rng(1), children: [{ name: 'bar', detail: '()', kind: 5, tags: [], range: rng(2), selectionRange: rng(2) }] }])
  })

  it('diagnostics paint gutter glyphs and fill the Problems store until the file closes', async () => {
    const t = setup()
    const a = t.nodeModel('/w/a.ts')
    const s = t.sockets[0]!.s
    await t.live(s)
    s.push({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///w/a.ts', diagnostics: [{ range: { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } }, message: 'Cannot find name x.', severity: 1, source: 'ts', code: 2304 }] } })
    expect(a.decorations).toEqual([{ range: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 1 }, options: { glyphMarginClassName: 'codicon codicon-error lsp-glyph lsp-glyph--error', glyphMarginHoverMessage: { value: 'Cannot find name x.' } } }])
    expect(lspProblems()).toEqual([{ file: '/w/a.ts', line: 4, column: 3, severity: 'error', message: 'Cannot find name x.', source: 'ts', code: '2304' }])
    const b = t.nodeModel('/w/a.ts', 'x', 'n2') // a second node on the same file gets the glyphs it missed
    expect(b.decorations).toHaveLength(1)
    a.dispose()
    b.dispose()
    expect(lspProblems()).toEqual([])
  })

  it('Go to Definition into a file no editor node shows asks App to open one at the line', () => {
    const t = setup()
    const opened: unknown[] = []
    const off = setLspFileOpener((...args) => opened.push(args))
    const trigger = vi.fn()
    expect(t.openers[0].openCodeEditor({ trigger }, Uri.file('/w/lib.ts'), { startLineNumber: 7, startColumn: 3, endLineNumber: 7, endColumn: 9 })).toBe(true)
    expect(opened).toEqual([['/w/lib.ts', 7, 3]])
    off()
    t.openers[0].openCodeEditor({ trigger }, Uri.file('/w/lib.ts'), undefined)
    expect(trigger).toHaveBeenCalledWith('lsp', 'editor.action.peekDefinition', null) // no App opener: peek in place
  })

  it('no server: the install hint reaches the hint store for ts and js', async () => {
    const t = setup()
    t.nodeModel('/w/a.ts')
    const s = t.sockets[0]!.s
    s.open()
    s.push({ webterm: LSP_UNAVAILABLE, message: 'TypeScript language server not found for this workspace.', command: 'npm install -D typescript-language-server typescript' })
    s.close(SERVER_CLOSE.unavailable)
    expect(lspHint('typescript')?.command).toBe('npm install -D typescript-language-server typescript')
    expect(lspHint('javascript')).not.toBeNull()
  })

  it('answers server->client requests (workspace/configuration gets one null per item)', async () => {
    const t = setup()
    t.nodeModel('/w/a.ts')
    const s = t.sockets[0]!.s
    await t.live(s)
    s.push({ jsonrpc: '2.0', id: 9, method: 'workspace/configuration', params: { items: [{}, {}] } })
    expect(s.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 9, result: [null, null] })
  })
})
