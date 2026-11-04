// LSP wiring against a fake Monaco + fake WebSocket: which models join a session, what goes on
// the wire, and what the providers hand back to Monaco.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LSP_CLOSE as SERVER_CLOSE, LSP_UNAVAILABLE as SERVER_UNAVAILABLE, LSP_WS_PATH as SERVER_PATH } from '../server/lsp/lsp.contract'
import { LSP_UNAVAILABLE, LSP_WS_PATH } from './editorLsp.client'
import { applyTextEdits, toCompletion, toHover, toLocations } from './editorLsp.convert'
import { lspHint, setLspHint } from './editorLsp.hints'
import { wireEditorLsp, type EditorLspDeps } from './editorLsp.monaco'

class Uri {
  constructor(readonly path: string, readonly fragment = '', readonly scheme = 'file') {}
  static file(p: string) { return new Uri(p) }
  static parse(s: string) { return new Uri(decodeURIComponent(s.replace(/^file:\/\//, '').split('#')[0]!)) }
  with(o: { fragment: string }) { return new Uri(this.path, o.fragment) }
  toString() { return `file://${this.path}${this.fragment ? `#${this.fragment}` : ''}` }
}

interface FakeModel {
  uri: Uri; text: string; disposed: boolean
  getLanguageId(): string; getValue(): string; isDisposed(): boolean; setText(t: string): void
  onDidChangeContent(cb: () => void): { dispose(): void }; onWillDispose(cb: () => void): void; dispose(): void
  getWordUntilPosition(): { startColumn: number; endColumn: number; word: string }
}

function fakeMonaco() {
  const created: ((m: FakeModel) => void)[] = []
  const providers: Record<string, Record<string, any>> = {}
  const markers = new Map<FakeModel, unknown[]>()
  const models: FakeModel[] = []
  const reg = (kind: string) => (lang: string, p: unknown) => { (providers[lang] ??= {})[kind] = p; return { dispose() {} } }
  const defaults = () => ({ modeConfiguration: { hovers: true, completionItems: true }, setModeConfiguration: vi.fn(function (this: { modeConfiguration: unknown }, c: unknown) { this.modeConfiguration = c }) })
  const m = {
    Uri,
    editor: {
      getModels: () => models.filter((x) => !x.disposed),
      getModel: (u: Uri) => models.find((x) => !x.disposed && x.uri.toString() === u.toString()) ?? null,
      createModel: (text: string, _l: unknown, uri: Uri) => model(uri, text),
      onDidCreateModel: (cb: (m: FakeModel) => void) => { created.push(cb) },
      onDidChangeModelLanguage: () => {},
      setModelMarkers: (md: FakeModel, _o: string, ms: unknown[]) => markers.set(md, ms),
      registerEditorOpener: () => ({ dispose() {} }),
      getEditors: () => [],
    },
    languages: {
      registerHoverProvider: reg('hover'), registerCompletionItemProvider: reg('completion'), registerDefinitionProvider: reg('definition'),
      registerReferenceProvider: reg('references'), registerRenameProvider: reg('rename'),
      CompletionItemKind: { Text: 18, Function: 1, Variable: 4 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    },
    typescript: { typescriptDefaults: defaults(), javascriptDefaults: defaults() },
  }
  function model(uri: Uri, text: string, languageId = uri.path.endsWith('.py') ? 'python' : uri.path.endsWith('.js') ? 'javascript' : 'typescript'): FakeModel {
    const changes: (() => void)[] = []
    const disposers: (() => void)[] = []
    const md: FakeModel = {
      uri, text, disposed: false,
      getLanguageId: () => languageId, getValue: () => md.text, isDisposed: () => md.disposed,
      setText(t: string) { md.text = t; changes.forEach((c) => c()) },
      onDidChangeContent: (cb: () => void) => { changes.push(cb); return { dispose() {} } },
      onWillDispose: (cb: () => void) => { disposers.push(cb) },
      dispose() { disposers.forEach((d) => d()); md.disposed = true },
      getWordUntilPosition: () => ({ startColumn: 1, endColumn: 3, word: 'fo' }),
    }
    models.push(md)
    created.forEach((c) => c(md))
    return md
  }
  return { m, model, providers, markers, models }
}

class FakeSocket {
  sent: any[] = []
  readyState = 0
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  send(s: string) { this.sent.push(JSON.parse(s)) }
  close(code = 1000) { if (this.closed) return; this.closed = true; this.onclose?.({ code }) }
  open() { this.readyState = 1; this.onopen?.() }
  push(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }) }
  reply(method: string, result: unknown) { const r = [...this.sent].reverse().find((s) => s.method === method); this.push({ jsonrpc: '2.0', id: r.id, result }) }
  methods() { return this.sent.map((s) => s.method) }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function setup(over: Partial<EditorLspDeps> = {}) {
  const f = fakeMonaco()
  const sockets: { ws: string; lang: string; s: FakeSocket }[] = []
  const deps: EditorLspDeps = {
    workspaceId: () => 'w1',
    open: (ws, lang) => { const s = new FakeSocket(); sockets.push({ ws, lang, s }); return s as unknown as WebSocket },
    readMeta: vi.fn(async () => ({ content: 'const a = 1\nconst b = a\n', version: 'v1', encoding: 'utf8' as const })),
    writeChecked: vi.fn(async () => ({ ok: true as const })),
    ...over,
  }
  wireEditorLsp(f.m as never, deps)
  const nodeModel = (path: string, text = 'x', node = 'n1') => f.model(Uri.file(path).with({ fragment: node }), text)
  /** Open the socket and complete the initialize handshake. */
  const live = async (s: FakeSocket) => { s.open(); s.reply('initialize', { capabilities: {} }); await tick() }
  return { ...f, sockets, deps, nodeModel, live }
}

afterEach(() => { setLspHint('typescript', null); setLspHint('python', null) })

describe('wireEditorLsp', () => {
  it('pins the wire constants to the server contract', () => {
    expect(LSP_WS_PATH).toBe(SERVER_PATH)
    expect(LSP_UNAVAILABLE).toBe(SERVER_UNAVAILABLE)
  })

  it('registers hover/completion/definition/references/rename for ts, js and python', () => {
    const { providers } = setup()
    for (const lang of ['typescript', 'javascript', 'python']) expect(Object.keys(providers[lang]!).sort()).toEqual(['completion', 'definition', 'hover', 'references', 'rename'])
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
    const a = t.nodeModel('/w/a.ts')
    const s = t.sockets[0]!.s
    await t.live(s)
    const p = t.providers.typescript!.rename.provideRenameEdits(a, { lineNumber: 1, column: 7 }, 'z')
    const r = (l: number, c: number) => ({ start: { line: l, character: c }, end: { line: l, character: c + 1 } })
    s.reply('textDocument/rename', { changes: { 'file:///w/a.ts': [{ range: r(0, 6), newText: 'z' }], 'file:///w/other.ts': [{ range: r(0, 6), newText: 'z' }, { range: r(1, 10), newText: 'z' }] } })
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
    expect(await p).toEqual({ edits: [], rejectReason: 'Rename could not update /w/other.ts: changed on disk' })
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
})
