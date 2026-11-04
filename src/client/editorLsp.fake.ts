// test-only: fake Monaco + fake WebSocket (a scripted language server over the real LspConnection) for editorLsp.monaco.test.ts.
import { vi } from 'vitest'
import { wireEditorLsp, type EditorLspDeps } from './editorLsp.monaco'

export class Uri {
  constructor(readonly path: string, readonly fragment = '', readonly scheme = 'file') {}
  static file(p: string) { return new Uri(p) }
  static parse(s: string) { return new Uri(decodeURIComponent(s.replace(/^file:\/\//, '').split('#')[0]!)) }
  with(o: { fragment: string }) { return new Uri(this.path, o.fragment) }
  toString() { return `file://${this.path}${this.fragment ? `#${this.fragment}` : ''}` }
}

export interface FakeModel {
  uri: Uri; text: string; disposed: boolean
  getLanguageId(): string; getValue(): string; isDisposed(): boolean; setText(t: string): void
  onDidChangeContent(cb: () => void): { dispose(): void }; onWillDispose(cb: () => void): void; dispose(): void
  getWordUntilPosition(): { startColumn: number; endColumn: number; word: string }
  decorations: any[]; deltaDecorations(old: string[], next: any[]): string[]
}

export function fakeMonaco() {
  const created: ((m: FakeModel) => void)[] = []
  const providers: Record<string, Record<string, any>> = {}
  const markers = new Map<FakeModel, unknown[]>()
  const openers: any[] = []
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
      registerEditorOpener: (o: unknown) => { openers.push(o); return { dispose() {} } },
      getEditors: () => [],
    },
    languages: {
      registerHoverProvider: reg('hover'), registerCompletionItemProvider: reg('completion'), registerDefinitionProvider: reg('definition'),
      registerReferenceProvider: reg('references'), registerRenameProvider: reg('rename'),
      registerSignatureHelpProvider: reg('signature'), registerDocumentSymbolProvider: reg('symbols'),
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
      decorations: [],
      deltaDecorations(_old: string[], next: any[]) { md.decorations = next; return next.map((_, i) => `d${i}`) },
    }
    models.push(md)
    created.forEach((c) => c(md))
    return md
  }
  return { m, model, providers, markers, models, openers }
}

export class FakeSocket {
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

export const ALL_CAPS = {
  hoverProvider: true, completionProvider: { triggerCharacters: ['.'] }, definitionProvider: true, referencesProvider: true,
  renameProvider: true, signatureHelpProvider: { triggerCharacters: ['('] }, documentSymbolProvider: true,
}

export const tick = () => new Promise((r) => setTimeout(r, 0))

export function setup(over: Partial<EditorLspDeps> = {}) {
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
  /** Open the socket and complete the initialize handshake; the fake server offers every feature unless `capabilities` says otherwise. */
  const live = async (s: FakeSocket, capabilities: Record<string, unknown> = ALL_CAPS) => { s.open(); s.reply('initialize', { capabilities }); await tick() }
  return { ...f, sockets, deps, nodeModel, live }
}
