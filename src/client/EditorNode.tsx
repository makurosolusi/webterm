import { memo, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { Button as VscodeButton, ToolbarButton, ToolbarContainer } from '@/vscode/register'
import { fileIconClass } from './fileIcon'
import { VscodeBreadcrumbs } from './components/vscode/vscodeBreadcrumbs'
import * as fsClient from './fsClient'
import { writeClipboard } from './clipboard'
import { EditorConflictBar } from './EditorConflictBar'
import { useEditorFile, type WriteChecked } from './useEditorFile'
import type { ReadMeta } from '../shared/fsContract'
import {
  IMAGE_MIME,
  base64ToBytes,
  editorFileKind,
  fileBaseName,
  fileExt,
  loadRefusal
} from './editorFile'
import './editor.css'

export interface EditorNodeProps extends NodeProps {
  /** @deprecated Tak dipakai lagi (teks lewat `readMeta`); masih diteruskan `nodeTypes.tsx`.
   *  TODO(fm-ws02): hapus bersama `write` setelah nodeTypes berhenti meneruskannya. */
  read?: (path: string) => Promise<string>
  /** @deprecated Tak dipakai lagi (simpan lewat `writeChecked`); lihat `read`. */
  write?: (path: string, content: string) => Promise<boolean>
  /** Isi file sebagai base64 (gambar & PDF); REJECT saat gagal baca. */
  readBinary: (path: string) => Promise<string>
  /** Isi teks + `version` + `encoding`; REJECT saat gagal baca. Default `fsClient.readMeta`. */
  readMeta?: (path: string) => Promise<ReadMeta>
  /** Tulis dengan cek versi (`EVERSION`/`ENOENT` lewat `FsResult`). Default `fsClient.writeChecked`. */
  writeChecked?: WriteChecked
  /** Setting: file Markdown dibuka langsung sebagai preview terender. Hanya menentukan tampilan
   *  SAAT node dibuka — toggle Preview/Edit tetap dua arah sesudahnya. */
  openMarkdownPreview?: boolean
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

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
  readBinary,
  readMeta = fsClient.readMeta,
  writeChecked = fsClient.writeChecked,
  openMarkdownPreview = false
}: EditorNodeProps) {
  const rf = useReactFlow()
  const d = data as { filePath?: string; color?: string }
  const filePath = d.filePath ?? ''
  const swatch = d.color ?? '#0a84ff'

  const fileName = fileBaseName(filePath) || 'untitled'
  const ext = fileExt(filePath)
  const kind = editorFileKind(filePath)

  const hostRef = useRef<HTMLDivElement>(null)
  const hoveredRef = useRef(false)
  const [loadError, setLoadError] = useState('')
  const [imageSrc, setImageSrc] = useState('')
  const [imageDims, setImageDims] = useState('')
  const [pdfSrc, setPdfSrc] = useState('')

  const ef = useEditorFile({
    id, filePath, fileName, ext, hostRef, readMeta, writeChecked, setLoadError,
    enabled: kind === 'text', openMarkdownPreview
  })
  const noViewer = kind !== 'text' && kind !== 'image' && kind !== 'pdf'
  const isBinary = kind === 'text' && ef.encoding === 'binary'
  // Monaco hanya dipasang untuk teks yang BUKAN biner: tombol Save/Preview ikut hilang untuk sisanya.
  const editable = kind === 'text' && !isBinary && !loadError
  const readOnly = ef.encoding === 'non-utf8'

  // Gambar: data URL base64 + <img>. TANPA zoom/pan — nodeterm juga tidak punya.
  useEffect(() => {
    if (kind !== 'image' || !filePath) return
    let disposed = false
    readBinary(filePath).then(
      (b64) => {
        if (disposed) return
        const refusal = loadRefusal(b64, 'Image')
        if (refusal) setLoadError(refusal)
        else setImageSrc(`data:${IMAGE_MIME[ext]};base64,${b64}`)
      },
      (err: unknown) => {
        if (!disposed) setLoadError(`Couldn’t read ${fileName}: ${errText(err)}`)
      }
    )
    return () => {
      disposed = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sekali per node; path node tidak berubah
  }, [])

  // PDF: blob URL + <iframe> ke viewer platform (zoom/cari/halaman/print gratis). Data URL tidak
  // bisa dipakai di sini — di dalam frame ia origin opaque dan viewer-nya merender kosong.
  useEffect(() => {
    if (kind !== 'pdf' || !filePath) return
    let disposed = false
    let url = ''
    readBinary(filePath).then(
      (b64) => {
        if (disposed) return
        const refusal = loadRefusal(b64, 'PDF')
        if (refusal) {
          setLoadError(refusal)
          return
        }
        const bytes = base64ToBytes(b64)
        if (!bytes) {
          setLoadError(`Couldn’t read ${fileName}: isinya bukan base64 yang sah.`)
          return
        }
        url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
        setPdfSrc(url)
      },
      (err: unknown) => {
        if (!disposed) setLoadError(`Couldn’t read ${fileName}: ${errText(err)}`)
      }
    )
    return () => {
      disposed = true
      // WAJIB: blob URL memaku byte-nya di memori sampai dicabut — beberapa node PDF yang pernah
      // dibuka akan menahan puluhan MB masing-masing selama sesi hidup.
      if (url) URL.revokeObjectURL(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sekali per node; path node tidak berubah
  }, [])

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
    if (noViewer || isBinary)
      return (
        <div className="editor-node__placeholder">
          <span>{isBinary ? 'File biner — tidak dapat dibuka sebagai teks.' : `File ${kind} — belum ada penampil untuk jenis ini.`}</span>
          <VscodeButton secondary title="Copy file path" onClick={() => void writeClipboard(filePath)}>
            Copy Path
          </VscodeButton>
        </div>
      )
    if (kind === 'image')
      return imageSrc ? (
        <img
          src={imageSrc}
          alt={fileName}
          onLoad={(e) => {
            const img = e.currentTarget
            if (img.naturalWidth) setImageDims(`${img.naturalWidth} × ${img.naturalHeight}`)
          }}
        />
      ) : (
        <span className="editor-node__notice">Loading…</span>
      )
    if (kind === 'pdf')
      return pdfSrc ? (
        <iframe src={pdfSrc} title={fileName} />
      ) : (
        <span className="editor-node__notice">Loading…</span>
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
            {/* Isi file adalah input tak terpercaya; `renderMarkdown` mensanitasi lewat DOMPurify
                dan fail-closed kalau sanitizer-nya tidak hidup. */}
            <div className="editor-node__md-body" dangerouslySetInnerHTML={{ __html: ef.previewHtml }} />
          </div>
        )}
      </>
    )
  }

  return (
    <>
      <NodeResizer isVisible={!!selected} minWidth={320} minHeight={180} color={swatch} />
      <div
        className={`term-node editor-node${selected ? ' term-node--selected' : ''}`}
        style={{ '--node-swatch': swatch } as CSSProperties}
        onMouseEnter={() => (hoveredRef.current = true)}
        onMouseLeave={() => (hoveredRef.current = false)}
      >
        <div className="node-header">
          <span className="node-title editor-node__name" title={filePath}>
            <span className={`${fileIconClass(fileName)} editor-node__icon`} aria-hidden="true" />
            {fileName}
            {editable && ef.dirty && (
              <span className="codicon codicon-circle-filled editor-node__dirty" role="img" aria-label="Unsaved changes" />
            )}
          </span>
          <span className="editor-node__spacer" />
          {kind === 'image' && imageDims && <span className="editor-node__dims">{imageDims}</span>}
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
              Bukan UTF-8 — dibuka read-only supaya byte aslinya tidak rusak.
            </div>
          )}
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

export default memo(EditorNode)
