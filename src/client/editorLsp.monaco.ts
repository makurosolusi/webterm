// Monaco <-> language server. Every editor-node model (file uri + `#nodeId` fragment, see
// useEditorFile.ts) of a served language joins the session for (workspace, server language);
// the first model opens `/ws/lsp`, the last one closing closes it (the server keeps the process
// warm, lsp.manager.ts). Hover, completion, definition, references, rename and diagnostics come
// from the server; Monaco's built-in TS worker steps back for those while a TS server is live.
//
// Tiru: VS Code's language client (didOpen/didChange full/didClose + providers), without
// monaco-languageclient: that package replaces monaco-editor with the @codingame VS Code build.
import type * as Monaco from 'monaco-editor'
import type { FsResult, FsVersion, ReadMeta } from '../shared/fsContract'
import { LspConnection } from './editorLsp.client'
import {
  applyTextEdits, toCompletion, toHover, toLocations, toLspPosition, toMarker, toRange, workspaceEdits,
  type LspCompletionItem, type LspDiagnostic, type LspHover, type LspLocation, type LspWorkspaceEdit,
} from './editorLsp.convert'
import { LSP_LANGUAGE_IDS, setLspHint, type ServerLanguage } from './editorLsp.hints'

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

interface Doc { version: number; models: Set<Model> }
interface Session { key: string; lang: ServerLanguage; conn: LspConnection; docs: Map<string, Doc>; live: boolean }

const serverLanguage = (languageId: string): ServerLanguage | undefined =>
  (Object.keys(LSP_LANGUAGE_IDS) as ServerLanguage[]).find((l) => (LSP_LANGUAGE_IDS[l] as readonly string[]).includes(languageId))

const lspLanguageId = (path: string, languageId: string): string =>
  path.endsWith('.tsx') ? 'typescriptreact' : path.endsWith('.jsx') ? 'javascriptreact' : languageId

export function wireEditorLsp(m: M, deps: EditorLspDeps): void {
  const sessions = new Map<string, Session>()
  const attached = new Map<Model, Session>()
  const peek = new Set<Model>()
  const fileUri = (path: string) => m.Uri.file(path).toString()

  const setBuiltinTs = (on: boolean) => {
    for (const d of [m.typescript.typescriptDefaults, m.typescript.javascriptDefaults]) {
      d.setModeConfiguration({ ...d.modeConfiguration, completionItems: on, hovers: on, definitions: on, references: on, rename: on, diagnostics: on })
    }
  }
  let builtinOff = false
  const syncBuiltin = () => {
    // ponytail: global switch; while a TS server is live, non-node TS models (diff views) lose built-in hover too.
    const off = [...sessions.values()].some((s) => s.live && s.lang === 'typescript')
    if (off !== builtinOff) { builtinOff = off; setBuiltinTs(!off) }
  }

  const session = (ws: string, lang: ServerLanguage): Session => {
    const key = `${ws}\0${lang}`
    const have = sessions.get(key)
    if (have) return have
    const s: Session = { key, lang, docs: new Map(), live: false, conn: null as unknown as LspConnection }
    s.conn = new LspConnection(deps.open(ws, lang), null, (conn) => {
      if (sessions.get(key) === s) sessions.delete(key)
      for (const doc of s.docs.values()) for (const md of doc.models) { attached.delete(md); if (!md.isDisposed()) m.editor.setModelMarkers(md, MARKER_OWNER, []) }
      s.live = false
      if (conn.hint) setLspHint(lang, conn.hint)
      if (sessions.size === 0) { for (const p of peek) p.dispose(); peek.clear() }
      syncBuiltin()
    })
    s.conn.ready.then(() => { s.live = true; setLspHint(lang, null); syncBuiltin() }, () => {})
    s.conn.onNotification((method, params) => {
      if (method !== 'textDocument/publishDiagnostics') return
      const p = params as { uri: string; diagnostics: LspDiagnostic[] }
      for (const md of s.docs.get(m.Uri.parse(p.uri).path)?.models ?? []) m.editor.setModelMarkers(md, MARKER_OWNER, p.diagnostics.map(toMarker))
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
      doc = { version: 1, models: new Set() }
      s.docs.set(path, doc)
      s.conn.notify('textDocument/didOpen', { textDocument: { uri, languageId: lspLanguageId(path, model.getLanguageId()), version: 1, text: model.getValue() } })
    }
    const d = doc
    d.models.add(model)
    attached.set(model, s)
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
    if (doc && doc.models.size === 0) {
      s.docs.delete(path)
      s.conn.notify('textDocument/didClose', { textDocument: { uri: fileUri(path) } })
    }
    if (s.docs.size === 0) s.conn.close()
  }

  const live = (model: Model): Session | null => { const s = attached.get(model); return s?.live ? s : null }
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

  /** Rename edits for files no editor holds go straight to disk, version-checked; any failure rejects the whole rename. */
  const renameOnDisk = async (path: string, edits: Parameters<typeof applyTextEdits>[1]): Promise<string | null> => {
    try {
      const meta = await deps.readMeta(path)
      const r = await deps.writeChecked(path, applyTextEdits(meta.content, edits), { expectedVersion: meta.version, mustExist: true })
      if (!r.ok) return `${path}: ${r.error}`
      const stale = m.editor.getModel(m.Uri.file(path))
      if (stale && peek.delete(stale)) stale.dispose()
      return null
    } catch (e) {
      return `${path}: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  for (const languageId of Object.values(LSP_LANGUAGE_IDS).flat()) {
    m.languages.registerHoverProvider(languageId, {
      provideHover: async (model, pos) => { const s = live(model); return s ? toHover(await s.conn.request<LspHover | null>('textDocument/hover', at(model, pos))) : null },
    })
    m.languages.registerCompletionItemProvider(languageId, {
      triggerCharacters: TRIGGER_CHARACTERS,
      provideCompletionItems: async (model, pos) => {
        const s = live(model)
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
        const s = live(model)
        return s ? locations(s, model, toLocations(await s.conn.request('textDocument/definition', at(model, pos)))) : null
      },
    })
    m.languages.registerReferenceProvider(languageId, {
      provideReferences: async (model, pos) => {
        const s = live(model)
        return s ? locations(s, model, toLocations(await s.conn.request('textDocument/references', { ...at(model, pos), context: { includeDeclaration: true } }))) : null
      },
    })
    m.languages.registerRenameProvider(languageId, {
      provideRenameEdits: async (model, pos, newName) => {
        const s = live(model)
        if (!s) return null
        const byUri = workspaceEdits(await s.conn.request<LspWorkspaceEdit | null>('textDocument/rename', { ...at(model, pos), newName }))
        const edits: Monaco.languages.IWorkspaceTextEdit[] = []
        const failed: string[] = []
        for (const [uri, list] of byUri) {
          const doc = s.docs.get(m.Uri.parse(uri).path)
          if (doc) for (const md of doc.models) for (const e of list) edits.push({ resource: md.uri, textEdit: { range: toRange(e.range), text: e.newText }, versionId: undefined })
          else { const f = await renameOnDisk(m.Uri.parse(uri).path, list); if (f) failed.push(f) }
        }
        return failed.length ? { edits: [], rejectReason: `Rename could not update ${failed.join('; ')}` } : { edits }
      },
    })
  }

  // Go to Definition into another file: reveal it in the node already showing it, else peek in place.
  m.editor.registerEditorOpener({
    openCodeEditor(source, resource, selection) {
      const target = m.editor.getEditors().find((e) => e !== source && e.getModel()?.uri.path === resource.path && !!e.getModel()?.uri.fragment)
      if (!target) { source.trigger('lsp', 'editor.action.peekDefinition', null); return true }
      const pos = selection && 'startLineNumber' in selection ? { lineNumber: selection.startLineNumber, column: selection.startColumn } : selection
      if (pos) { target.setPosition(pos); target.revealLineInCenter(pos.lineNumber) }
      target.focus()
      return true
    },
  })

  for (const model of m.editor.getModels()) attach(model)
  m.editor.onDidCreateModel(attach)
  m.editor.onDidChangeModelLanguage(({ model }) => { detach(model); attach(model) })
}
