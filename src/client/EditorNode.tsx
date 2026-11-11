import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useReactFlow, type NodeProps } from '@xyflow/react'
import { NodeLayoutResizer, NodeResizeToggle } from './nodeResize/NodeLayoutResizer'
import { Button as VscodeButton, ToolbarButton, ToolbarContainer } from '@/vscode/register'
import { fileIconClass } from './fileIcon'
import { VscodeBreadcrumbs } from './components/vscode/vscodeBreadcrumbs'
import * as fsClient from './fsClient'
import { writeClipboard } from './clipboard'
import { EditorConflictBar } from './EditorConflictBar'
import { useEditorFile, type WriteChecked } from './useEditorFile'
import { useEditorSync } from './useEditorSync'
import { ViewerHost } from './viewers/ViewerHost'
import type { FileKind } from '../shared/fileKind'
import type { ReadMeta } from '../shared/fsContract'
import { editorFileKind, fileBaseName, fileExt } from './editorFile'
import { dismissLspHint, lspLanguageIdForExt, useLspHint } from './editorLsp.hints'
import { EditorRenamePreview } from './EditorRenamePreview'
import { loadMonaco } from './lazyMonaco'
import { ShowInFilesButton } from './ShowInFilesButton'
import './editor.css'
import { NodeNameLabel } from './nodeName.label'
import { WordWrapButton } from './editorWrap'
import { useEditorView } from './EditorNode.view'

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
  /** `stat` untuk membandingkan versi saat direktori ditandai berubah. Default `fsClient.stat`. */
  stat?: typeof fsClient.stat
}

/**
 * Node editor/preview file. Teks dimuat/disimpan lewat `useEditorFile` (cek versi, konflik,
 * biner, non-UTF-8); gambar dan PDF jadi preview; audio/video/archive/biner jadi placeholder jujur.
 *
 * Port dari nodeterm `src/renderer/nodes/EditorNode.tsx`. Bedanya: fs masuk sebagai prop callback
 * (webterm tidak punya preload Electron), dan tidak ada cabang SSH/worktree.
 */
function EditorNode({
  id,
  data,
  selected,
  readMeta = fsClient.readMeta,
  writeChecked = fsClient.writeChecked,
  openMarkdownPreview = false,
  stat = fsClient.stat
}: EditorNodeProps) {
  const rf = useReactFlow()
  const d = data as { filePath?: string; color?: string; name?: string }
  const filePath = d.filePath ?? ''
  const swatch = d.color ?? '#0a84ff'

  const fileName = fileBaseName(filePath) || 'untitled'
  const ext = fileExt(filePath)
  const kind = editorFileKind(filePath)

  const hostRef = useRef<HTMLDivElement>(null)
  const hoveredRef = useRef(false)
  const [loadError, setLoadError] = useState('')

  const ef = useEditorFile({
    id, filePath, fileName, ext, hostRef, readMeta, writeChecked, setLoadError,
    enabled: kind === 'text', openMarkdownPreview
  })
  const isBinary = kind === 'text' && ef.encoding === 'binary'
  // Monaco hanya dipasang untuk teks yang BUKAN biner: tombol Save/Preview ikut hilang untuk sisanya.
  const editable = kind === 'text' && !isBinary && !loadError
  const readOnly = ef.encoding === 'non-utf8'
  // No language server for this file's language: say so, with the one command that fixes it.
  const lspLanguage = editable ? lspLanguageIdForExt(ext) : ''
  const lspHint = useLspHint(lspLanguage)
  const view = useEditorView(id, filePath, ef.live, MIN_WIDTH)

  // Rename lewat bus fs: path (dan judul, yang diturunkan dari path) ikut lewat data node yang sama
  // dengan `updateNodeData` lain, jadi persist & daftar node ikut tanpa jalur baru.
  const sync = useEditorSync({
    filePath, text: kind === 'text', stat,
    setPath: (p) => rf.updateNodeData(id, { filePath: p }),
    snapshot: ef.snapshot, reload: ef.reload, flagConflict: ef.flagConflict
  })

  // ⌘M / Ctrl+M menukar preview saat node ini di-hover — gerbang hover yang sama dengan nodeterm
  // (`canvasOwnsMarkdownChord`), supaya satu chord tidak menyalakan setiap node editor di board.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hoveredRef.current || e.key.toLowerCase() !== 'm' || !(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      ef.toggleRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const body = (): React.ReactNode => {
    if (loadError) return <span className="editor-node__notice">{loadError}</span>
    if (kind !== 'text')
      return sync.missing ? (
        <span className="editor-node__notice">{fileName} was deleted on disk.</span>
      ) : (
        <ViewerHost path={filePath} kind={kind as FileKind} version={sync.viewVersion} />
      )
    if (isBinary)
      return (
        <div className="editor-node__placeholder">
          <span>Binary file — can’t be opened as text.</span>
          <VscodeButton secondary title="Copy file path" onClick={() => void writeClipboard(filePath)}>
            Copy Path
          </VscodeButton>
        </div>
      )
    return (
      <>
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
              <span className="editor-node__md-hint">⌘M to edit</span>
            </div>
            <Suspense fallback={null}>
              <EditorMarkdownPreview source={ef.previewSource} filePath={filePath} nodeId={id} />
            </Suspense>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      <NodeLayoutResizer minWidth={MIN_WIDTH} minHeight={180} color={swatch} onFitWidth={view.fit} />
      <div
        className={`term-node editor-node${selected ? ' term-node--selected' : ''}`}
        style={{ '--node-swatch': swatch } as CSSProperties}
        onMouseEnter={() => (hoveredRef.current = true)}
        onMouseLeave={() => (hoveredRef.current = false)}
      >
        <div className="node-header" onContextMenu={editable ? view.openMenu : undefined}>
          <span
            className="node-title editor-node__name"
            title={filePath}
          >
            <span className={`${fileIconClass(fileName)} editor-node__icon`} aria-hidden="true" />
            <NodeNameLabel name={d.name} label={fileName} />
            {editable && ef.dirty && (
              <span className="codicon codicon-circle-filled editor-node__dirty" role="img" aria-label="Unsaved changes" />
            )}
          </span>
          <span className="editor-node__spacer" />
          <ShowInFilesButton editorId={id} />
          <NodeResizeToggle />
          <ToolbarContainer className="nodrag editor-node__actions">
            {editable && (
              <>
                <ToolbarButton
                  label={ef.preview ? 'Edit' : 'Preview'}
                  title="Toggle markdown preview (⌘M)" data-title="Toggle markdown preview (⌘M)"
                  toggleable checked={ef.preview}
                  onClick={ef.togglePreview}
                >
                  <span className={`codicon codicon-${ef.preview ? 'edit' : 'open-preview'}`} aria-hidden="true" />
                </ToolbarButton>
                <WordWrapButton on={view.wrap} onToggle={view.toggleWrap} />
                {lspLanguage && (
                  <ToolbarButton label="Outline" title="Go to symbol in file (⇧⌘O)" data-title="Go to symbol in file (⇧⌘O)" onClick={() => void showOutline(id)}>
                    <span className="codicon codicon-symbol-class" aria-hidden="true" />
                  </ToolbarButton>
                )}
                {/* Save memakai tombol primer VS Code, bukan toolbar button: ia satu-satunya aksi
                    yang mengubah file, dan hanya menyala saat ada perbedaan yang belum tersimpan. */}
                {!readOnly && (
                  <VscodeButton secondary disabled={!ef.dirty} title="Save (⌘S)" onClick={ef.save}>
                    Save
                  </VscodeButton>
                )}
              </>
            )}
            <ToolbarButton
              label="Close"
              title="Close"
              onClick={() => {
                void rf.deleteElements({ nodes: [{ id }] })
              }}
            >
              <span className="codicon codicon-close" aria-hidden="true" />
            </ToolbarButton>
          </ToolbarContainer>
        </div>
        {view.menu}
        {/* Breadcrumb path file seperti di bawah tab editor VS Code: 3 segmen terakhir, statis. */}
        {filePath && (
          <VscodeBreadcrumbs
            className="nodrag editor-node__crumbs"
            ariaLabel="File path"
            segments={filePath.split('/').filter(Boolean).slice(-3).map((name, i, all) => ({
              id: `${i}:${name}`,
              label: name,
              title: filePath,
              icon: i === all.length - 1 ? <span className={`${fileIconClass(name)} editor-node__icon`} aria-hidden="true" /> : undefined,
            }))}
          />
        )}
        <div className={`node-body editor-node__body editor-node__body--${kind}`}>
          {body()}
          {/* Strip DI ATAS body, bukan pengganti body: editor tetap terpasang, isinya tetap
              terlihat, dan tombol Save tetap `dirty` sehingga bisa dicoba ulang. */}
          {editable && readOnly && (
            <div className="editor-node__banner nodrag" role="status">
              Not UTF-8: opened read-only so the original bytes are not corrupted.
            </div>
          )}
          {lspHint && (
            <div className="editor-node__banner editor-node__lsp-hint nodrag" role="status">
              <span>{lspHint.message} Install it with <code>{lspHint.command}</code></span>
              <VscodeButton secondary title="Copy install command" onClick={() => void writeClipboard(lspHint.command)}>Copy command</VscodeButton>
              <ToolbarButton label="Dismiss" title="Dismiss" onClick={() => dismissLspHint(lspLanguage)}>
                <span className="codicon codicon-close" aria-hidden="true" />
              </ToolbarButton>
            </div>
          )}
          {editable && <EditorRenamePreview nodeId={id} />}
          {editable && ef.conflict && (
            <EditorConflictBar conflict={ef.conflict} fileName={fileName} onReload={() => void ef.reload()} onOverwrite={ef.overwrite} />
          )}
          {ef.saveError && (
            <div className="editor-node__save-error nodrag" role="alert">
              {ef.saveError}
            </div>
          )}
        </div>
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
