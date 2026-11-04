import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { editor as MonacoEditor } from 'monaco-editor'
import type { FsResult, FsVersion, ReadEncoding, ReadMeta } from '../shared/fsContract'
import { loadMonaco } from './lazyMonaco'
import { currentMonacoTheme, EDITOR_OPTIONS } from './monacoTheme'
import { renderMarkdown } from './markdown'
import { loadRefusal, opensInPreview } from './editorFile'

export type EditorConflict = { kind: 'version'; current?: FsVersion } | { kind: 'missing' }
export type WriteChecked = (path: string, content: string, opts?: { expectedVersion?: FsVersion; mustExist?: boolean }) => Promise<FsResult>

export interface UseEditorFileArgs {
  id: string
  filePath: string
  fileName: string
  ext: string
  /** false untuk gambar/PDF/biner: hook tidak membaca apa pun dan tidak memuat Monaco. */
  enabled: boolean
  openMarkdownPreview: boolean
  hostRef: RefObject<HTMLDivElement | null>
  readMeta: (path: string) => Promise<ReadMeta>
  writeChecked: WriteChecked
  setLoadError: (msg: string) => void
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Pemuatan + penyimpanan file teks node editor. Seluruh jalur tulis lewat `expectedVersion`:
 * tidak ada ⌘S yang menimpa tanpa versi yang dibaca. Konflik (`EVERSION`) dan file terhapus
 * (`ENOENT`) tidak membuang buffer — keduanya jadi `conflict` untuk `EditorConflictBar`.
 */
export function useEditorFile(a: UseEditorFileArgs) {
  const { id, fileName, ext, enabled, hostRef } = a
  // Path SAAT INI: rename mengganti path tanpa membuang buffer, jadi baca/tulis memakai ref —
  // efek pemuatan (di bawah) sengaja tidak bergantung pada path.
  const pathRef = useRef(a.filePath)
  pathRef.current = a.filePath
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const savedRef = useRef('')
  const versionRef = useRef<FsVersion>('')
  const readOnlyRef = useRef(false)
  const savingRef = useRef(false)
  // GERBANG KEHILANGAN DATA: hanya true setelah pembacaan selesai dan isinya benar-benar masuk ke
  // model. Tanpa ini, ⌘S pada node yang gagal memuat akan menulis buffer kosong ke file pengguna.
  const loadedRef = useRef(false)
  const [dirty, setDirty] = useState(false)
  const [preview, setPreview] = useState(false)
  const [previewHtml, setPreviewHtml] = useState('')
  const [encoding, setEncoding] = useState<ReadEncoding>('utf8')
  const [conflict, setConflict] = useState<EditorConflict | null>(null)
  // TERPISAH dari `loadError` dengan sengaja: gagal BACA menolak merender editor, gagal SIMPAN harus
  // MEMPERTAHANKAN editor — editan yang belum tersimpan hanya hidup di dalam instance Monaco.
  const [saveError, setSaveError] = useState('')

  const togglePreview = () => {
    if (!enabled || !loadedRef.current) return
    setPreview((p) => {
      const next = !p
      if (next && editorRef.current) setPreviewHtml(renderMarkdown(editorRef.current.getValue()))
      return next
    })
  }

  /** Satu percobaan tulis; `opts` menentukan seberapa ketat (versi / harus ada). */
  const doWrite = (opts: { expectedVersion?: FsVersion; mustExist?: boolean }) => {
    const editor = editorRef.current
    if (!editor || !loadedRef.current || readOnlyRef.current || savingRef.current) return
    const value = editor.getValue()
    savingRef.current = true
    a.writeChecked(pathRef.current, value, opts).then(
      (r) => {
        savingRef.current = false
        if (r.ok) {
          savedRef.current = value
          if (r.version !== undefined) versionRef.current = r.version
          // Bandingkan dengan isi SEKARANG: pengguna mungkin mengetik selagi request berjalan.
          setDirty(editor.getValue() !== value)
          setConflict(null)
          setSaveError('')
        } else if (r.code === 'EVERSION') {
          setConflict({ kind: 'version', current: r.current })
        } else if (r.code === 'ENOENT') {
          setConflict({ kind: 'missing' })
        } else {
          setSaveError(`Couldn’t save ${fileName}: ${r.error}`)
        }
      },
      (err: unknown) => {
        savingRef.current = false
        setSaveError(`Couldn’t save ${fileName}: ${errText(err)}`)
      }
    )
  }

  const save = () => {
    // Guard !dirty: ⌘S pada buffer bersih tidak menulis (menghindari mtime berubah & EVERSION palsu).
    if (!editorRef.current || editorRef.current.getValue() === savedRef.current) return
    doWrite({ expectedVersion: versionRef.current, mustExist: true })
  }
  const saveRef = useRef(save)
  saveRef.current = save
  const toggleRef = useRef(togglePreview)
  toggleRef.current = togglePreview

  /** Timpa eksplisit atas pilihan pengguna di bar konflik; buffer pengguna yang menang. */
  const overwrite = () => {
    if (!conflict) return
    doWrite(conflict.kind === 'version' ? { expectedVersion: conflict.current, mustExist: true } : {})
  }

  /** Ganti buffer dengan isi disk. `onlyIfClean`: auto-reload dari perubahan remote — batal jadi
   *  konflik bila pengguna sempat mengetik selagi baca berjalan (buffer tidak boleh hilang). */
  const reload = async (onlyIfClean = false) => {
    const editor = editorRef.current
    if (!editor) return
    try {
      const meta = await a.readMeta(pathRef.current)
      const refusal = loadRefusal(meta.content, 'File', true)
      if (refusal || meta.encoding !== 'utf8') {
        setSaveError(refusal ?? `${fileName} is no longer UTF-8 text; the buffer was not replaced.`)
        return
      }
      if (onlyIfClean && editor.getValue() !== savedRef.current) {
        setConflict({ kind: 'version', current: meta.version })
        return
      }
      savedRef.current = meta.content
      versionRef.current = meta.version
      editor.setValue(meta.content)
      setDirty(false)
      setConflict(null)
      setSaveError('')
    } catch (err) {
      setSaveError(`Couldn’t reload ${fileName}: ${errText(err)}`)
    }
  }

  /** Pandangan sesaat untuk `useEditorSync`: dirty/saving/versi terakhir yang dikenal. */
  const snapshot = () => ({
    dirty: !!editorRef.current && editorRef.current.getValue() !== savedRef.current,
    saving: savingRef.current,
    version: versionRef.current
  })

  // Teks: baca dulu (versi + encoding), baru muat Monaco — biner tidak boleh memicu pemuatan Monaco.
  useEffect(() => {
    if (!enabled || !pathRef.current) return
    // Berganti jenis (mis. rename .txt -> .png lalu balik) = muat ulang bersih, bukan sisa state lama.
    setDirty(false)
    setConflict(null)
    setEncoding('utf8')
    setPreview(false)
    const filePath = pathRef.current
    let disposed = false
    let model: MonacoEditor.ITextModel | null = null
    let editor: MonacoEditor.IStandaloneCodeEditor | null = null
    let themeObserver: MutationObserver | null = null

    a.readMeta(filePath)
      .then(async (meta) => {
        if (disposed) return
        const refusal = loadRefusal(meta.content, 'File', true)
        if (refusal) {
          // MENOLAK membuka, bukan membuka buffer kosong: ⌘S di atas placeholder akan menimpa
          // file (besar) yang asli dengan nol byte.
          a.setLoadError(refusal)
          return
        }
        if (meta.encoding === 'binary') {
          setEncoding('binary')
          return
        }
        const m = await loadMonaco()
        const host = hostRef.current
        if (disposed || !host) return
        readOnlyRef.current = meta.encoding === 'non-utf8'
        // Satu model per NODE (fragment = id node): dua node pada file yang sama tidak berbagi model.
        const uri = m.Uri.file(filePath).with({ fragment: id })
        model = m.editor.getModel(uri) ?? m.editor.createModel(meta.content, undefined, uri)
        editor = m.editor.create(host, { ...EDITOR_OPTIONS, model, theme: currentMonacoTheme(), readOnly: readOnlyRef.current })
        // Monaco memegang satu tema global: ikuti pergantian Dark/Light app selama node ini hidup.
        themeObserver = new MutationObserver(() => m.editor.setTheme(currentMonacoTheme()))
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
        editorRef.current = editor
        savedRef.current = meta.content
        versionRef.current = meta.version
        loadedRef.current = true
        setEncoding(meta.encoding)
        editor.onDidChangeModelContent(() => setDirty(editor!.getValue() !== savedRef.current))
        editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => saveRef.current())
        if (opensInPreview(ext, a.openMarkdownPreview)) {
          setPreviewHtml(renderMarkdown(meta.content))
          setPreview(true)
        }
      })
      .catch((err: unknown) => {
        // Gagal baca TIDAK boleh berakhir sebagai editor kosong: `loadedRef` tetap false sehingga
        // `save()` keluar lebih awal dan file asli aman dari ⌘S.
        if (!disposed) a.setLoadError(`Couldn’t open ${fileName}: ${errText(err)}`)
      })

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- path lewat pathRef; hanya jenis (enabled) yang memuat ulang
  }, [enabled])

  return { dirty, preview, previewHtml, encoding, conflict, saveError, togglePreview, toggleRef, save, reload, overwrite, snapshot, flagConflict: setConflict }
}
