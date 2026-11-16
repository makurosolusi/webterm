import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useReactFlow, type NodeProps } from '@xyflow/react'
import { NodeLayoutResizer } from './nodeResize/NodeLayoutResizer'
import { Button as VscodeButton } from '@/vscode/register'
import { IconButton } from '@/components/ui/icon-button'
import NodeChrome, { termNodeClass } from './NodeChrome'
import { useNodeCollapse } from './nodeCollapse'
import { fileIconToneClass } from './fileIcon'
import { randomId } from './randomId'
import type { Comment } from '../shared/workspace'
import * as fsClient from './fsClient'
import { EditorConflictBar } from './EditorConflictBar'
import { EditorCrumbs, EditorDirtyDot, EditorHeaderActions, PREVIEW_COMMAND_ID, useFilesRoot } from './EditorNode.header'
import { EditorCompare } from './EditorNode.compare'
import { CopyText, EditorLoadFailure, EditorLoading } from './EditorNode.notices'
import EditorStatusBar, { runEditorAction, type ViewerMeta } from './EditorStatusBar'
import type { MenuRow } from './NodeContextMenu'
import { useEditorFile, type WriteChecked } from './useEditorFile'
import { useEditorSync } from './useEditorSync'
import { ViewerHost } from './viewers/ViewerHost'
import type { FileKind } from '../shared/fileKind'
import type { ReadMeta } from '../shared/fsContract'
import { editorFileKind, fileBaseName, fileExt, isMarkdownExt, loadRefusal } from './editorFile'
import { dismissLspHint, lspLanguageIdForExt, useLspHint } from './editorLsp.hints'
import { EditorRenamePreview } from './EditorRenamePreview'
import { loadMonaco } from './lazyMonaco'
import { useShowInFiles } from './ShowInFilesButton'
import './editor.css'
import { useWrapChord, wrapChordLabel } from './editorWrap'
import { useNodeHost } from './tabLayout.context'
import TabNodeActions, { type TabAction } from './tabLayout.nodeActions'
import { useEditorView } from './EditorNode.view'
import { chordLabel, useCommands } from './commandRegistry'
import { useKeybindingOverrides } from './keybindings.store'
import { commandKey, commandMatches } from './keybindings.resolve'
import { isMacPlatform } from './terminalKeys.platform'

// marked + DOMPurify load with the first preview, not with the board.
const EditorMarkdownPreview = lazy(() => import('./EditorMarkdownPreview'))
const MIN_WIDTH = 320

export interface EditorNodeProps extends NodeProps {
  /** Isi teks + `version` + `encoding`; REJECT saat gagal baca. Default `fsClient.readMeta`. */
  readMeta?: (path: string) => Promise<ReadMeta>
  /** Tulis dengan cek versi (`EVERSION`/`ENOENT` lewat `FsResult`). Default `fsClient.writeChecked`. */
  writeChecked?: WriteChecked
  /** Setting: file Markdown dibuka langsung sebagai preview terender. Hanya menentukan tampilan
   *  SAAT node dibuka — toggle Preview/Edit tetap dua arah sesudahnya. */
  openMarkdownPreview?: boolean
  /** The user switched Preview/Edit on a Markdown file: remembered as how the next one opens. */
  onPreviewChange?: (preview: boolean) => void
  /** `stat` untuk membandingkan versi saat direktori ditandai berubah. Default `fsClient.stat`. */
  stat?: typeof fsClient.stat
}

/**
 * Node editor/preview file. Teks dimuat/disimpan lewat `useEditorFile` (cek versi, konflik,
 * biner, non-UTF-8); gambar dan PDF jadi preview; audio/video/archive/biner jadi placeholder jujur.
 *
 * Fs masuk sebagai prop callback
 * (webterm tidak punya preload Electron), dan tidak ada cabang SSH/worktree.
 */
function EditorNode({
  id,
  data,
  selected,
  height,
  readMeta = fsClient.readMeta,
  writeChecked = fsClient.writeChecked,
  openMarkdownPreview = false,
  onPreviewChange,
  stat = fsClient.stat
}: EditorNodeProps) {
  const rf = useReactFlow()
  // `viewAs: 'text'` = "Open as Text" on a file the viewers would show (SVG, misdetected types); persisted (WsNode.viewAs).
  const d = data as { filePath?: string; color?: string; name?: string; title?: string; collapsed?: boolean; comments?: Comment[]; viewAs?: 'text' }
  const filePath = d.filePath ?? ''
  const swatch = d.color ?? '#0a84ff'
  const collapsed = d.collapsed ?? false
  const comments = d.comments ?? []
  const toggleCollapse = useNodeCollapse(id, height, collapsed)

  const fileName = fileBaseName(filePath) || 'untitled'
  const ext = fileExt(filePath)
  const detected = editorFileKind(filePath)
  const kind = d.viewAs === 'text' ? 'text' : detected
  const markdown = isMarkdownExt(ext)
  const [viewerMeta, setViewerMeta] = useState<ViewerMeta | null>(null)
  useEffect(() => setViewerMeta(null), [filePath, kind])
  const [comparing, setComparing] = useState(false)

  const hostRef = useRef<HTMLDivElement>(null)
  const hoveredRef = useRef(false)
  const [loadError, setLoadError] = useState('')

  const ef = useEditorFile({
    id, filePath, fileName, ext, hostRef, readMeta, writeChecked, setLoadError,
    enabled: kind === 'text', openMarkdownPreview, onPreviewChange
  })
  const isBinary = kind === 'text' && ef.encoding === 'binary'
  // Monaco hanya dipasang untuk teks yang BUKAN biner: aksi Save/Preview ikut hilang untuk sisanya.
  const editable = kind === 'text' && !isBinary && !loadError
  const readOnly = ef.encoding === 'non-utf8'
  // No language server for this file's language: say so, with the one command that fixes it.
  const lspLanguage = editable ? lspLanguageIdForExt(ext) : ''
  const lspHint = useLspHint(lspLanguage)
  useEffect(() => { if (!ef.conflict) setComparing(false) }, [ef.conflict])
  const live = ef.live
  const reopenAsPreview = d.viewAs === 'text' && detected !== 'text' ? () => rf.updateNodeData(id, { viewAs: undefined }) : null
  const menuLead: MenuRow[] = [
    ...(!readOnly ? [{ label: ef.saving ? 'Saving…' : 'Save', hint: 'Save (⌘S)', disabled: !ef.dirty || ef.saving, onClick: () => void ef.save() }] : []),
    { label: 'Go to Line/Column…', hint: 'Go to Line/Column (Ctrl+G)', disabled: !live, onClick: () => live && runEditorAction(live.editor, 'editor.action.gotoLine') },
    { label: 'Command Palette…', hint: 'Show All Commands (F1)', disabled: !live, onClick: () => live && runEditorAction(live.editor, 'editor.action.quickCommand') },
    ...(reopenAsPreview ? [{ label: 'Reopen as Preview', onClick: reopenAsPreview }] : []),
  ]
  const view = useEditorView(id, filePath, ef.live, MIN_WIDTH, menuLead)
  const previewChord = commandKey(PREVIEW_COMMAND_ID, useCommands(), useKeybindingOverrides())
  const previewKey = previewChord ? chordLabel(previewChord, isMacPlatform()) : ''
  const previewTitle = previewKey ? `Toggle markdown preview (${previewKey})` : 'Toggle markdown preview'
  const wrapKey = wrapChordLabel(useWrapChord())
  const showInFiles = useShowInFiles(id)
  const filesRoot = useFilesRoot(id)
  const close = () => { void rf.deleteElements({ nodes: [{ id }] }) }
  const compareSides = async () => {
    const meta = await readMeta(filePath)
    const refusal = loadRefusal(meta.content, 'File', true)
    if (refusal) throw new Error(refusal)
    return { path: filePath, original: meta.content, modified: live?.editor.getValue() ?? '' }
  }
  // Tab mode: the tab is the header, so the header's actions move to the tab strip and tab menu.
  const host = useNodeHost()
  const tabActions: TabAction[] = [
    ...(showInFiles ? [{ id: 'show-in-files', label: 'Show in Files', icon: 'folder-opened', onSelect: showInFiles }] : []),
    ...(editable ? [
      ...(markdown ? [{ id: 'preview', label: ef.preview ? 'Edit' : 'Preview', tooltip: previewTitle, icon: ef.preview ? 'edit' : 'open-preview', checked: ef.preview, onSelect: ef.togglePreview }] : []),
      { id: 'wrap', label: 'Word wrap', tooltip: wrapKey ? `Toggle word wrap (${wrapKey})` : 'Toggle word wrap', icon: 'word-wrap', checked: view.wrap, onSelect: view.toggleWrap },
      ...(lspLanguage ? [{ id: 'outline', label: 'Outline', tooltip: 'Go to symbol in file (⇧⌘O)', icon: 'symbol-class', onSelect: () => void showOutline(id) }] : []),
      ...(!readOnly ? [{ id: 'save', label: ef.saving ? 'Saving…' : 'Save', tooltip: 'Save (⌘S)', disabled: !ef.dirty || ef.saving, busy: ef.saving, onSelect: () => void ef.save() }] : []),
    ] : []),
  ]

  // Rename lewat bus fs: path (dan judul, yang diturunkan dari path) ikut lewat data node yang sama
  // dengan `updateNodeData` lain, jadi persist & daftar node ikut tanpa jalur baru.
  const sync = useEditorSync({
    filePath, text: kind === 'text', stat,
    // A title that was just the old file name (how a node opens) follows the rename; a custom one stays.
    setPath: (p) => rf.updateNodeData(id, (n) => ({ filePath: p, ...((n.data as { title?: string }).title === fileName ? { title: undefined } : {}) })),
    snapshot: ef.snapshot, reload: ef.reload, flagConflict: ef.flagConflict
  })

  // Markdown: Toggle Preview (default ⌘M / Ctrl+M, rebindable via the registry) menukar preview
  // saat node ini di-hover — gerbang hover (`canvasOwnsMarkdownChord`),
  // supaya satu chord tidak menyalakan setiap node editor di board.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hoveredRef.current || !commandMatches(e, PREVIEW_COMMAND_ID)) return
      e.preventDefault()
      ef.toggleRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const body = (): React.ReactNode => {
    if (loadError) return <EditorLoadFailure message={loadError} filePath={filePath} onRetry={ef.retryLoad} onShowInFiles={showInFiles} />
    if (kind !== 'text')
      return sync.missing ? (
        <span className="editor-node__notice">{fileName} was deleted on disk.</span>
      ) : (
        <ViewerHost path={filePath} kind={kind as FileKind} version={sync.viewVersion} onOpenAsText={() => rf.updateNodeData(id, { viewAs: 'text' })} onMeta={setViewerMeta} />
      )
    if (isBinary)
      return (
        <div className="editor-node__placeholder">
          <span>Binary file — can’t be opened as text.</span>
          <CopyText text={filePath} title="Copy file path">Copy Path</CopyText>
          {reopenAsPreview && <VscodeButton secondary onClick={reopenAsPreview}>Reopen as Preview</VscodeButton>}
        </div>
      )
    return (
      <>
        {!live && <EditorLoading />}
        {/* `nokey` KRUSIAL: React Flow hanya berhenti mengambil keyboard untuk input/select/
            textarea atau atribut contenteditable (`isInputDOMNode` di @xyflow/system), sementara
            Monaco 0.57 mengetik lewat div EditContext (opsi `editContext` default true) yang bukan
            salah satunya. Tanpa `nokey`, mengetik akan mem-pan canvas dan Backspace menghapus
            node. `nodrag` supaya seleksi teks tidak menggeser node, `nowheel` supaya scroll
            menggulung editor, bukan men-zoom canvas. */}
        <div className="editor-node__monaco nodrag nowheel nokey" ref={hostRef} />
        {ef.preview && (
          <div className="editor-node__md nodrag nowheel">
            <div className="editor-node__md-bar">
              <span>Preview</span>
              {previewKey && <span className="editor-node__md-hint">{previewKey} to edit</span>}
            </div>
            <Suspense fallback={null}>
              <EditorMarkdownPreview source={ef.previewSource} filePath={filePath} nodeId={id} />
            </Suspense>
          </div>
        )}
        {comparing && ef.conflict && (
          <EditorCompare fileName={fileName} load={compareSides} onClose={() => setComparing(false)} />
        )}
      </>
    )
  }

  return (
    <>
      <NodeLayoutResizer collapsed={collapsed} minWidth={MIN_WIDTH} minHeight={180} color={swatch} onFitWidth={view.fit} />
      <div
        className={`${termNodeClass({ selected: !!selected, collapsed })} editor-node`}
        style={{ '--node-swatch': swatch } as CSSProperties}
        onMouseEnter={() => (hoveredRef.current = true)}
        onMouseLeave={() => (hoveredRef.current = false)}
      >
        {host.inTab ? <TabNodeActions id={id} visible={host.visible} items={[]} actions={tabActions} dirty={editable && ef.dirty} /> : (
          <NodeChrome
            title={d.title || fileName} name={d.name} iconClass={fileIconToneClass(fileName)} titleHint={filePath || fileName}
            onRename={(t) => rf.updateNodeData(id, { title: t })}
            collapsed={collapsed} onToggleCollapse={toggleCollapse}
            color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
            comments={comments} onAddComment={(text) => rf.updateNodeData(id, { comments: [...comments, { id: randomId(), text, ts: Date.now() }] })}
            statusChip={editable && ef.dirty ? <EditorDirtyDot /> : undefined}
            extraHeader={
              <EditorHeaderActions
                id={id} editable={editable} markdown={markdown} preview={ef.preview} onTogglePreview={ef.togglePreview}
                wrap={view.wrap} onToggleWrap={view.toggleWrap} onOutline={lspLanguage ? () => void showOutline(id) : undefined}
              />
            }
            menuItems={editable ? view.items : undefined}
            closeLabel="Close" onClose={close}
            onContextMenu={editable ? view.openMenu : undefined}
          />
        )}
        {view.menu}
        {/* Breadcrumb under the header, as under a VS Code editor tab: the path relative to the Files node. */}
        {filePath && <EditorCrumbs filePath={filePath} root={filesRoot} onFolder={showInFiles} />}
        <div className={`node-body editor-node__body editor-node__body--${kind}`}>
          {body()}
          {/* Strip DI ATAS body, bukan pengganti body: editor tetap terpasang, isinya tetap
              terlihat, dan buffer tetap `dirty` sehingga ⌘S / Retry bisa mencoba ulang. */}
          {editable && readOnly && (
            <div className="editor-node__banner nodrag" role="status">
              Not UTF-8: opened read-only so the original bytes are not corrupted.
            </div>
          )}
          {lspHint && (
            <div className="editor-node__banner editor-node__lsp-hint nodrag" role="status">
              <span>{lspHint.message} Install it with <code>{lspHint.command}</code></span>
              <CopyText text={lspHint.command} title="Copy install command">Copy command</CopyText>
              <IconButton size="icon-xs" label="Dismiss" onClick={() => dismissLspHint(lspLanguage)}>
                <span className="codicon codicon-close" aria-hidden="true" />
              </IconButton>
            </div>
          )}
          {editable && <EditorRenamePreview nodeId={id} />}
          {editable && ef.conflict && (
            <EditorConflictBar conflict={ef.conflict} fileName={fileName} onReload={() => void ef.reload()} onOverwrite={ef.overwrite} onCompare={() => setComparing(true)} />
          )}
          {ef.saveError && (
            <div className="editor-node__save-error nodrag" role="alert">
              <span>{ef.saveError}</span>
              <VscodeButton secondary disabled={ef.saving} onClick={ef.retry}>Retry</VscodeButton>
            </div>
          )}
        </div>
        <EditorStatusBar live={live} encoding={ef.encoding} saving={ef.saving} readOnly={readOnly} meta={kind !== 'text' ? viewerMeta : null} />
      </div>
    </>
  )
}

/** Open Monaco's symbol list (document symbols from the language server) in editor node `nodeId`. */
async function showOutline(nodeId: string): Promise<void> {
  const m = await loadMonaco()
  const ed = m.editor.getEditors().find((e) => e.getModel()?.uri.fragment === nodeId)
  ed?.focus()
  ed?.trigger('outline', 'editor.action.quickOutline', null)
}

export default memo(EditorNode)
