// Monaco <-> language server. Every editor-node model (file uri + `#nodeId` fragment, see
// useEditorFile.ts) of a served language joins the session for (workspace, server language);
// the first model opens `/ws/lsp`, the last one closing closes it (the server keeps the process
// warm, lsp.manager.ts). Hover, completion, definition, references, rename and diagnostics come
// from the server, plus signature help and document symbols (Go to Symbol / outline); Monaco's
// built-in TS worker steps back for those while a TS server is live. Diagnostics also paint a
// gutter glyph and feed the Problems panel (editorLsp.store.ts). Rename shows its edits for
// approval before anything is written.
//
// Tiru: VS Code's language client (didOpen/didChange full/didClose + providers), without
// monaco-languageclient: that package replaces monaco-editor with the @codingame VS Code build.
import type * as Monaco from 'monaco-editor'
import type { FsResult, FsVersion, ReadMeta } from '../shared/fsContract'
import { LspConnection } from './editorLsp.client'
import {
  applyTextEdits, renamePreviewLines, toCompletion, toDocumentSymbols, toHover, toLocations, toLspPosition, toMarker, toRange, toSignatureHelp, workspaceEdits,
  type LspCompletionItem, type LspDiagnostic, type LspDocumentSymbol, type LspHover, type LspLocation, type LspSignatureHelp, type LspSymbolInformation, type LspTextEdit, type LspWorkspaceEdit,
} from './editorLsp.convert'
import { LSP_LANGUAGE_IDS, setLspHint, type ServerLanguage } from './editorLsp.hints'
import { lspFileOpener, requestRenamePreview, setLspProblems, type LspProblem } from './editorLsp.store'

type M = typeof Monaco
type Model = Monaco.editor.ITextModel

export interface EditorLspDeps {
  /** Workspace whose cwd roots the server ('' = none yet: models are not served). */
  workspaceId(): string
  open(workspaceId: string, language: ServerLanguage): WebSocket
  readMeta(path: string): Promise<ReadMeta>
  writeChecked(path: string, content: string, opts: { expectedVersion?: FsVersion; mustExist?: boolean }): Promise<FsResult>
}

/** Files fetched read-only so Peek can show a definition/reference outside open editors. ponytail: cap, not paging. */
export const PEEK_FILES_MAX = 50
const TRIGGER_CHARACTERS = ['.', '"', "'", '/', '@', '<']
const MARKER_OWNER = 'lsp'
/** LSP DiagnosticSeverity -> codicon / Problems severity. */
const GLYPH: Record<number, 'error' | 'warning' | 'info'> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'info' }
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface Doc { version: number; models: Set<Model>; diags: LspDiagnostic[] }
/** Server capability (initialize result) behind each Monaco built-in TS mode switch; diagnostics are pushed, so any live server owns them. */
const MODE_CAPABILITY = {
  completionItems: 'completionProvider', hovers: 'hoverProvider', definitions: 'definitionProvider', references: 'referencesProvider',
  rename: 'renameProvider', signatureHelp: 'signatureHelpProvider', documentSymbols: 'documentSymbolProvider', diagnostics: null,
} as const
type Capability = Exclude<(typeof MODE_CAPABILITY)[keyof typeof MODE_CAPABILITY], null>

interface Session { key: string; lang: ServerLanguage; conn: LspConnection; docs: Map<string, Doc>; live: boolean; caps: Record<string, unknown> }

const serverLanguage = (languageId: string): ServerLanguage | undefined =>
  (Object.keys(LSP_LANGUAGE_IDS) as ServerLanguage[]).find((l) => (LSP_LANGUAGE_IDS[l] as readonly string[]).includes(languageId))

const lspLanguageId = (path: string, languageId: string): string =>
  path.endsWith('.tsx') ? 'typescriptreact' : path.endsWith('.jsx') ? 'javascriptreact' : languageId

export function wireEditorLsp(m: M, deps: EditorLspDeps): void {
  const sessions = new Map<string, Session>()
  const attached = new Map<Model, Session>()
  const peek = new Set<Model>()
  const glyphs = new Map<Model, string[]>()
  const fileUri = (path: string) => m.Uri.file(path).toString()

  /** Squiggles (markers) + one gutter glyph per diagnostic on one model. */
  const paint = (md: Model, diags: LspDiagnostic[]) => {
    if (md.isDisposed()) return
    m.editor.setModelMarkers(md, MARKER_OWNER, diags.map(toMarker))
    const ids = md.deltaDecorations(glyphs.get(md) ?? [], diags.map((d) => {
      const line = d.range.start.line + 1
      const sev = GLYPH[d.severity ?? 1] ?? 'error'
      return { range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: { glyphMarginClassName: `codicon codicon-${sev} lsp-glyph lsp-glyph--${sev}`, glyphMarginHoverMessage: { value: d.message } } }
    }))
    if (ids.length) glyphs.set(md, ids); else glyphs.delete(md)
  }
  const problemsOf = (lang: ServerLanguage, path: string, diags: LspDiagnostic[]): LspProblem[] => diags.map((d) => ({
    file: path, line: d.range.start.line + 1, column: d.range.start.character + 1, severity: GLYPH[d.severity ?? 1] ?? 'error',
    message: d.message, source: d.source ?? lang, ...(d.code !== undefined ? { code: String(d.code) } : {}),
  }))

  let builtinKey = ''
  const syncBuiltin = () => {
    // A built-in feature steps back only while a live TS server offers it; one it lacks stays Monaco's.
    // ponytail: global switch; while a TS server is live, non-node TS models (diff views) lose those built-ins too.
    const ts = [...sessions.values()].filter((s) => s.live && s.lang === 'typescript')
    const mode = Object.fromEntries(Object.entries(MODE_CAPABILITY).map(([k, cap]) => [k, !ts.some((s) => cap === null || !!s.caps[cap])]))
    const key = JSON.stringify(mode)
    if (key === builtinKey) return
    const first = !builtinKey
    builtinKey = key
    if (first && Object.values(mode).every(Boolean)) return // already Monaco's defaults
    for (const d of [m.typescript.typescriptDefaults, m.typescript.javascriptDefaults]) d.setModeConfiguration({ ...d.modeConfiguration, ...mode })
  }

  const session = (ws: string, lang: ServerLanguage): Session => {
    const key = `${ws}\0${lang}`
    const have = sessions.get(key)
    if (have) return have
    const s: Session = { key, lang, docs: new Map(), live: false, caps: {}, conn: null as unknown as LspConnection }
    s.conn = new LspConnection(deps.open(ws, lang), null, (conn) => {
      if (sessions.get(key) === s) sessions.delete(key)
      for (const [path, doc] of s.docs) { setLspProblems(path, []); for (const md of doc.models) { attached.delete(md); paint(md, []) } }
      s.live = false
      if (conn.hint) setLspHint(lang, conn.hint)
      if (sessions.size === 0) { for (const p of peek) p.dispose(); peek.clear() }
      syncBuiltin()
    })
    s.conn.ready.then((init) => {
      s.caps = (init as { capabilities?: Record<string, unknown> } | null)?.capabilities ?? {}
      s.live = true
      setLspHint(lang, null)
      syncBuiltin()
    }, () => {})
    s.conn.onNotification((method, params) => {
      if (method !== 'textDocument/publishDiagnostics') return
      const p = params as { uri: string; diagnostics: LspDiagnostic[] }
      const path = m.Uri.parse(p.uri).path
      const doc = s.docs.get(path)
      if (!doc) return // ponytail: open files only; the workspace-wide list is the Problems panel's tsc/eslint run
      doc.diags = p.diagnostics
      for (const md of doc.models) paint(md, doc.diags)
      setLspProblems(path, problemsOf(lang, path, doc.diags))
    })
    sessions.set(key, s)
    return s
  }

  const attach = (model: Model) => {
    if (model.uri.scheme !== 'file' || !model.uri.fragment || attached.has(model)) return
    const lang = serverLanguage(model.getLanguageId())
    const ws = deps.workspaceId()
    if (!lang || !ws) return
    const s = session(ws, lang)
    const path = model.uri.path
    const uri = fileUri(path)
    let doc = s.docs.get(path)
    if (!doc) {
      doc = { version: 1, models: new Set(), diags: [] }
      s.docs.set(path, doc)
      s.conn.notify('textDocument/didOpen', { textDocument: { uri, languageId: lspLanguageId(path, model.getLanguageId()), version: 1, text: model.getValue() } })
    }
    const d = doc
    d.models.add(model)
    attached.set(model, s)
    if (d.diags.length) paint(model, d.diags)
    // ponytail: full-text sync; incremental (TextDocumentSyncKind 2) when big files feel slow.
    const sub = model.onDidChangeContent(() => {
      if (attached.get(model) !== s) return
      d.version++
      s.conn.notify('textDocument/didChange', { textDocument: { uri, version: d.version }, contentChanges: [{ text: model.getValue() }] })
    })
    model.onWillDispose(() => { sub.dispose(); detach(model) })
  }

  const detach = (model: Model) => {
    const s = attached.get(model)
    if (!s) return
    attached.delete(model)
    const path = model.uri.path
    const doc = s.docs.get(path)
    doc?.models.delete(model)
    paint(model, [])
    if (doc && doc.models.size === 0) {
      s.docs.delete(path)
      setLspProblems(path, [])
      s.conn.notify('textDocument/didClose', { textDocument: { uri: fileUri(path) } })
    }
    if (s.docs.size === 0) s.conn.close()
  }

  /** The live session for `model` when its server offers `cap` (else the provider stays silent and Monaco's built-in answers). */
  const live = (model: Model, cap: Capability): Session | null => { const s = attached.get(model); return s?.live && s.caps[cap] ? s : null }
  const at = (model: Model, pos: Monaco.IPosition) => ({ textDocument: { uri: fileUri(model.uri.path) }, position: toLspPosition(pos) })

  /** Map server locations to models Monaco can show: the node's own model, another open node's, or a read-only peek copy. */
  const locations = async (s: Session, from: Model, locs: LspLocation[]): Promise<Monaco.languages.Location[]> => {
    const out: Monaco.languages.Location[] = []
    const fetched = new Set<string>()
    for (const l of locs) {
      const path = m.Uri.parse(l.uri).path
      const open = path === from.uri.path ? from : [...(s.docs.get(path)?.models ?? [])][0]
      let uri = open?.uri
      if (!uri) {
        uri = m.Uri.file(path)
        if (!m.editor.getModel(uri)) {
          if (fetched.size >= PEEK_FILES_MAX && !fetched.has(path)) continue
          fetched.add(path)
          const meta = await deps.readMeta(path).catch((e: unknown) => { console.warn('lsp: cannot read definition target', path, e instanceof Error ? e.message : String(e)); return null })
          if (!meta || meta.encoding !== 'utf8') continue
          if (!m.editor.getModel(uri)) peek.add(m.editor.createModel(meta.content, undefined, uri))
        }
      }
      out.push({ uri, range: toRange(l.range) })
    }
    return out
  }

  /** A file a rename touches: open node models get Monaco edits, the rest is written to disk after approval. */
  interface RenameFile { path: string; edits: LspTextEdit[]; models: Model[]; meta?: ReadMeta }

  /** Write one renamed file no editor holds, version-checked against what the preview showed. */
  const renameOnDisk = async (path: string, meta: ReadMeta, edits: LspTextEdit[]): Promise<string | null> => {
    try {
      const r = await deps.writeChecked(path, applyTextEdits(meta.content, edits), { expectedVersion: meta.version, mustExist: true })
      if (!r.ok) return `${path}: ${r.error}`
      const stale = m.editor.getModel(m.Uri.file(path))
      if (stale && peek.delete(stale)) stale.dispose()
      return null
    } catch (e) {
      return `${path}: ${errText(e)}`
    }
  }

  /** Rename: collect every file's edits, show them in the asking node, and apply only on approval. */
  const rename = async (s: Session, model: Model, pos: Monaco.IPosition, newName: string): Promise<Monaco.languages.WorkspaceEdit & Monaco.languages.Rejection> => {
    const files: RenameFile[] = []
    const failed: string[] = []
    const reject = () => ({ edits: [], rejectReason: `Rename could not update ${failed.join('; ')}` })
    for (const [uri, edits] of workspaceEdits(await s.conn.request<LspWorkspaceEdit | null>('textDocument/rename', { ...at(model, pos), newName }))) {
      const path = m.Uri.parse(uri).path
      const models = [...(s.docs.get(path)?.models ?? [])]
      if (models.length) { files.push({ path, edits, models }); continue }
      const meta = await deps.readMeta(path).catch((e: unknown) => { failed.push(`${path}: ${errText(e)}`); return null })
      if (meta && meta.encoding !== 'utf8') failed.push(`${path}: not a UTF-8 text file`)
      else if (meta) files.push({ path, edits, models, meta })
    }
    if (failed.length) return reject()
    if (!files.length) return { edits: [] }
    const ok = await requestRenamePreview({
      nodeId: model.uri.fragment, newName,
      files: files.map((f) => ({ path: f.path, lines: renamePreviewLines(f.meta?.content ?? f.models[0]!.getValue(), f.edits) })),
    })
    if (!ok) return { edits: [], rejectReason: 'Rename cancelled.' }
    // ponytail: disk files are written one by one; a failure midway leaves the earlier ones renamed (all failures are named).
    for (const f of files) if (f.meta) { const e = await renameOnDisk(f.path, f.meta, f.edits); if (e) failed.push(e) }
    if (failed.length) return reject()
    return { edits: files.flatMap((f) => f.models.flatMap((md) => f.edits.map((e) => ({ resource: md.uri, textEdit: { range: toRange(e.range), text: e.newText }, versionId: undefined })))) }
  }

  for (const languageId of Object.values(LSP_LANGUAGE_IDS).flat()) {
    m.languages.registerHoverProvider(languageId, {
      provideHover: async (model, pos) => { const s = live(model, 'hoverProvider'); return s ? toHover(await s.conn.request<LspHover | null>('textDocument/hover', at(model, pos))) : null },
    })
    m.languages.registerCompletionItemProvider(languageId, {
      triggerCharacters: TRIGGER_CHARACTERS,
      provideCompletionItems: async (model, pos) => {
        const s = live(model, 'completionProvider')
        if (!s) return { suggestions: [] }
        const r = await s.conn.request<LspCompletionItem[] | { isIncomplete?: boolean; items: LspCompletionItem[] } | null>('textDocument/completion', at(model, pos))
        const w = model.getWordUntilPosition(pos)
        const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn }
        const items = Array.isArray(r) ? r : r?.items ?? []
        return { suggestions: items.map((i) => toCompletion(m, i, range)), incomplete: !Array.isArray(r) && !!r?.isIncomplete }
      },
    })
    m.languages.registerDefinitionProvider(languageId, {
      provideDefinition: async (model, pos) => {
        const s = live(model, 'definitionProvider')
        return s ? locations(s, model, toLocations(await s.conn.request('textDocument/definition', at(model, pos)))) : null
      },
    })
    m.languages.registerReferenceProvider(languageId, {
      provideReferences: async (model, pos) => {
        const s = live(model, 'referencesProvider')
        return s ? locations(s, model, toLocations(await s.conn.request('textDocument/references', { ...at(model, pos), context: { includeDeclaration: true } }))) : null
      },
    })
    m.languages.registerRenameProvider(languageId, {
      provideRenameEdits: async (model, pos, newName) => { const s = live(model, 'renameProvider'); return s ? rename(s, model, pos, newName) : null },
    })
    m.languages.registerSignatureHelpProvider(languageId, {
      signatureHelpTriggerCharacters: ['(', ','],
      signatureHelpRetriggerCharacters: [')'],
      provideSignatureHelp: async (model, pos, _token, ctx) => {
        const s = live(model, 'signatureHelpProvider')
        if (!s) return null
        const context = { triggerKind: ctx.triggerKind, isRetrigger: ctx.isRetrigger, ...(ctx.triggerCharacter ? { triggerCharacter: ctx.triggerCharacter } : {}) }
        const value = toSignatureHelp(await s.conn.request<LspSignatureHelp | null>('textDocument/signatureHelp', { ...at(model, pos), context }))
        return value ? { value, dispose() {} } : null
      },
    })
    m.languages.registerDocumentSymbolProvider(languageId, {
      provideDocumentSymbols: async (model) => {
        const s = live(model, 'documentSymbolProvider')
        return s ? toDocumentSymbols(await s.conn.request<(LspDocumentSymbol | LspSymbolInformation)[] | null>('textDocument/documentSymbol', { textDocument: { uri: fileUri(model.uri.path) } })) : null
      },
    })
  }

  // Go to Definition into another file: reveal it in the node already showing it, else open an
  // editor node for it (App's opener), else peek in place.
  m.editor.registerEditorOpener({
    openCodeEditor(source, resource, selection) {
      const target = m.editor.getEditors().find((e) => e !== source && e.getModel()?.uri.path === resource.path && !!e.getModel()?.uri.fragment)
      const pos = selection && 'startLineNumber' in selection ? { lineNumber: selection.startLineNumber, column: selection.startColumn } : selection
      const open = lspFileOpener()
      if (!target && open && resource.scheme === 'file') { open(resource.path, pos?.lineNumber ?? 1, pos?.column ?? 1); return true }
      if (!target) { source.trigger('lsp', 'editor.action.peekDefinition', null); return true }
      if (pos) { target.setPosition(pos); target.revealLineInCenter(pos.lineNumber) }
      target.focus()
      return true
    },
  })

  for (const model of m.editor.getModels()) attach(model)
  m.editor.onDidCreateModel(attach)
  m.editor.onDidChangeModelLanguage(({ model }) => { detach(model); attach(model) })
}
