import { memo, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { Button as VscodeButton, ToolbarButton, ToolbarContainer } from '@/vscode/register'
// Type-only: terhapus saat compile, jadi tidak membatalkan lazy-load Monaco.
import type { editor as MonacoEditor } from 'monaco-editor'
import { loadMonaco } from './lazyMonaco'
import { currentMonacoTheme, EDITOR_OPTIONS } from './monacoTheme'
import { fileIconClass } from './fileIcon'
import { VscodeBreadcrumbs } from './components/vscode/vscodeBreadcrumbs'
import { renderMarkdown } from './markdown'
import {
  IMAGE_MIME,
  base64ToBytes,
  editorFileKind,
  fileBaseName,
  fileExt,
  loadRefusal,
  opensInPreview
} from './editorFile'
import './editor.css'

export interface EditorNodeProps extends NodeProps {
  /** Isi teks file; REJECT saat gagal baca ('' berarti file memang kosong), sentinel too-large
   *  saat melewati cap `fsLimits`. Kontrak di kepala `./fsClient`. */
  read: (path: string) => Promise<string>
  /** Tulis teks; resolve true saat berhasil. */
  write: (path: string, content: string) => Promise<boolean>
  /** Isi file sebagai base64 (gambar & PDF); REJECT saat gagal baca. */
  readBinary: (path: string) => Promise<string>
  /** Setting: file Markdown dibuka langsung sebagai preview terender. Hanya menentukan tampilan
   *  SAAT node dibuka — toggle Preview/Edit tetap dua arah sesudahnya. */
  openMarkdownPreview?: boolean
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Node editor/preview file. Membaca file saat mount, menebak bahasa dari path-nya (pemetaan
 * ekstensi→bahasa milik Monaco sendiri lewat `monaco.Uri.file`, bukan tabel tulisan sendiri), dan
 * menulis balik dengan ⌘S atau tombol Save. File gambar dan PDF ditampilkan sebagai preview, tidak
 * dibuka sebagai teks (biner).
 *
 * Port dari nodeterm `src/renderer/nodes/EditorNode.tsx`. Bedanya: fs masuk sebagai prop callback
 * (webterm tidak punya preload Electron), dan tidak ada cabang SSH/worktree.
 */
function EditorNode({
  id,
  data,
  selected,
  read,
  write,
  readBinary,
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
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const savedRef = useRef('')
  // GERBANG KEHILANGAN DATA: hanya true setelah pembacaan selesai dan isinya benar-benar masuk ke
  // model. Tanpa ini, ⌘S pada node yang gagal memuat akan menulis buffer kosong ke file pengguna.
  const loadedRef = useRef(false)
  const hoveredRef = useRef(false)

  const [dirty, setDirty] = useState(false)
  const [preview, setPreview] = useState(false)
  const [previewHtml, setPreviewHtml] = useState('')
  const [loadError, setLoadError] = useState('')
  // TERPISAH dari `loadError` dengan sengaja — konsekuensinya berlawanan. Gagal BACA harus menolak
  // merender editor (buffer kosong di atas file berisi = ⌘S menimpanya). Gagal SIMPAN harus
  // MEMPERTAHANKAN editor: editan yang belum tersimpan hanya hidup di dalam instance Monaco, jadi
  // meng-unmount host-nya berarti membuang pekerjaan pengguna justru di saat penyimpanan gagal.
  const [saveError, setSaveError] = useState('')
  const [imageSrc, setImageSrc] = useState('')
  const [imageDims, setImageDims] = useState('')
  const [pdfSrc, setPdfSrc] = useState('')

  const togglePreview = () => {
    if (kind !== 'text' || !loadedRef.current) return
    setPreview((p) => {
      const next = !p
      if (next && editorRef.current) setPreviewHtml(renderMarkdown(editorRef.current.getValue()))
      return next
    })
  }
  // Handler disimpan di ref supaya listener keyboard & command Monaco (keduanya didaftarkan sekali)
  // selalu memanggil closure terbaru, bukan yang terbekukan saat mount.
  const toggleRef = useRef(togglePreview)
  toggleRef.current = togglePreview

  const save = () => {
    const editor = editorRef.current
    if (!editor || !loadedRef.current) return
    const value = editor.getValue()
    write(filePath, value).then(
      (ok) => {
        if (!ok) {
          setSaveError(`Couldn’t save ${fileName}.`)
          return
        }
        savedRef.current = value
        setDirty(false)
        // Pesan basi dibersihkan di sini, bukan di awal percobaan: kalau save gagal lagi, strip-nya
        // tidak sempat berkedip hilang-muncul.
        setSaveError('')
      },
      (err: unknown) => setSaveError(`Couldn’t save ${fileName}: ${errText(err)}`)
    )
  }
  const saveRef = useRef(save)
  saveRef.current = save

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

  // Teks: Monaco (dimuat malas) + pembacaan file, paralel.
  useEffect(() => {
    if (kind !== 'text' || !filePath) return
    let disposed = false
    let model: MonacoEditor.ITextModel | null = null
    let editor: MonacoEditor.IStandaloneCodeEditor | null = null
    let themeObserver: MutationObserver | null = null

    Promise.all([loadMonaco(), read(filePath)]).then(
      ([m, content]) => {
        if (disposed) return
        const refusal = loadRefusal(content, 'File', true)
        if (refusal) {
          // MENOLAK membuka, bukan membuka buffer kosong: ⌘S di atas placeholder akan menimpa
          // file (besar) yang asli dengan nol byte.
          setLoadError(refusal)
          return
        }
        const host = hostRef.current
        if (!host) return
        // Satu model per NODE: fragment berisi id node, supaya dua node yang membuka file yang
        // sama tidak berbagi (dan saling menimpa) satu model. Bahasa tetap ditebak Monaco dari
        // path-nya — `createModel` dengan language undefined memakai pemetaan ekstensi internal.
        const uri = m.Uri.file(filePath).with({ fragment: id })
        model = m.editor.getModel(uri) ?? m.editor.createModel(content, undefined, uri)
        editor = m.editor.create(host, { ...EDITOR_OPTIONS, model, theme: currentMonacoTheme() })
        // Monaco memegang satu tema global: ikuti pergantian Dark/Light app selama node ini hidup.
        themeObserver = new MutationObserver(() => m.editor.setTheme(currentMonacoTheme()))
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
        editorRef.current = editor
        savedRef.current = content
        loadedRef.current = true
        editor.onDidChangeModelContent(() => setDirty(editor!.getValue() !== savedRef.current))
        editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => saveRef.current())
        // Preview awal diputuskan di sini, bukan saat init useState, karena ia butuh isi file —
        // ini state yang sama dengan klik Preview tepat setelah load, jadi ⌘M/Edit tetap normal.
        if (opensInPreview(ext, openMarkdownPreview)) {
          setPreviewHtml(renderMarkdown(content))
          setPreview(true)
        }
      },
      (err: unknown) => {
        // `read` yang reject TIDAK boleh berakhir sebagai editor kosong: `loadError` membuat
        // `body()` merender notice alih-alih host Monaco, jadi editor tak pernah dibuat,
        // `loadedRef` tetap false dan `save()` keluar lebih awal — file asli aman dari ⌘S.
        if (!disposed) setLoadError(`Couldn’t open ${fileName}: ${errText(err)}`)
      }
    )

    return () => {
      disposed = true
      loadedRef.current = false
      themeObserver?.disconnect()
      editor?.dispose()
      // Model dibuang eksplisit: React tidak melepas resource Monaco hanya karena container-nya
      // keluar dari tree, dan model yang tertinggal menahan worker bahasanya (lihat tsWorkerReaper).
      model?.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sekali per node; path node tidak berubah
  }, [])

  // ⌘M / Ctrl+M menukar preview saat node ini di-hover — gerbang hover yang sama dengan nodeterm
  // (`canvasOwnsMarkdownChord`), supaya satu chord tidak menyalakan setiap node editor di board.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hoveredRef.current || e.key.toLowerCase() !== 'm' || !(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      toggleRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const body = (): React.ReactNode => {
    if (loadError) return <span className="editor-node__notice">{loadError}</span>
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
        {preview && (
          <div className="editor-node__md nodrag nowheel">
            <div className="editor-node__md-bar">
              <span>Preview</span>
              <span className="editor-node__md-hint">⌘M to edit</span>
            </div>
            {/* Isi file adalah input tak terpercaya; `renderMarkdown` mensanitasi lewat DOMPurify
                dan fail-closed kalau sanitizer-nya tidak hidup. */}
            <div className="editor-node__md-body" dangerouslySetInnerHTML={{ __html: previewHtml }} />
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
            {kind === 'text' && dirty && (
              <span className="codicon codicon-circle-filled editor-node__dirty" role="img" aria-label="Unsaved changes" />
            )}
          </span>
          <span className="editor-node__spacer" />
          {kind === 'image' && imageDims && <span className="editor-node__dims">{imageDims}</span>}
          <ToolbarContainer className="nodrag editor-node__actions">
            {kind === 'text' && !loadError && (
              <>
                <ToolbarButton
                  label={preview ? 'Edit' : 'Preview'}
                  title="Toggle markdown preview (⌘M)" data-title="Toggle markdown preview (⌘M)"
                  toggleable checked={preview}
                  onClick={togglePreview}
                >
                  <span className={`codicon codicon-${preview ? 'edit' : 'open-preview'}`} aria-hidden="true" />
                </ToolbarButton>
                {/* Save memakai tombol primer VS Code, bukan toolbar button: ia satu-satunya aksi
                    yang mengubah file, dan hanya menyala saat ada perbedaan yang belum tersimpan. */}
                <VscodeButton secondary disabled={!dirty} title="Save (⌘S)" onClick={save}>
                  Save
                </VscodeButton>
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
          {saveError && (
            <div className="editor-node__save-error nodrag" role="alert">
              {saveError}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export default memo(EditorNode)
