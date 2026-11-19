import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { IDisposable, editor as MonacoEditor } from 'monaco-editor'
import type { FsResult, FsVersion, ReadEncoding, ReadMeta } from '../shared/fsContract'
import { loadMonaco, type MonacoApi } from './lazyMonaco'
import { currentMonacoTheme, EDITOR_OPTIONS } from './monacoTheme'
import { isMarkdownExt, loadRefusal, opensInPreview } from './editorFile'
import { setEditorDirty } from './editorDirty'
import { useEditorMask } from './useEditorMask'

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
  /** Called with the new view when the user toggles Preview/Edit. */
  onPreviewChange?: (preview: boolean) => void
  hostRef: RefObject<HTMLDivElement | null>
  readMeta: (path: string) => Promise<ReadMeta>
  writeChecked: WriteChecked
  setLoadError: (msg: string) => void
}

/** Per-editor Save action id; Monaco prefixes it with the editor id, so every node owns its own. */
const SAVE_ACTION_ID = 'webterm.editor.save'
/** Typing while the preview is open re-renders it after this pause, not per keystroke. */
export const PREVIEW_DEBOUNCE_MS = 150

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
  /** Mirrors `savingRef` for rendering: true while a write request is in flight ("Saving…"). */
  const [saving, setSaving] = useState(false)
  // GERBANG KEHILANGAN DATA: hanya true setelah pembacaan selesai dan isinya benar-benar masuk ke
  // model. Tanpa ini, ⌘S pada node yang gagal memuat akan menulis buffer kosong ke file pengguna.
  const loadedRef = useRef(false)
  const [dirty, setDirty] = useState(false)
  const [preview, setPreview] = useState(false)
  // Markdown SOURCE for the preview (rendered by EditorMarkdownPreview): refreshed on toggle, on
  // reload, and debounced on edits while visible, so external changes and typing show up.
  const [previewSource, setPreviewSource] = useState('')
  const previewRef = useRef(false)
  previewRef.current = preview
  const [encoding, setEncoding] = useState<ReadEncoding>('utf8')
  const [conflict, setConflict] = useState<EditorConflict | null>(null)
  // TERPISAH dari `loadError` dengan sengaja: gagal BACA menolak merender editor, gagal SIMPAN harus
  // MEMPERTAHANKAN editor — editan yang belum tersimpan hanya hidup di dalam instance Monaco.
  const [saveError, setSaveError] = useState('')
  /** Which operation `saveError` came from, so Retry repeats that one. */
  const [failedOp, setFailedOp] = useState<'save' | 'reload'>('save')
  const fail = (op: 'save' | 'reload', msg: string) => { setFailedOp(op); setSaveError(msg) }
  /** Bumped by `retryLoad` so the load effect runs again after a read failure. */
  const [loadKey, setLoadKey] = useState(0)
  /** The mounted editor (null until Monaco is up), for options and actions owned by the node. */
  const [live, setLive] = useState<{ monaco: MonacoApi; editor: MonacoEditor.IStandaloneCodeEditor } | null>(null)
  // Secret masking (docs/decisions/secret-masking.md): while `mask.modeRef` is 'masked' the model holds display text.
  const mask = useEditorMask({ pathRef, editor: live?.editor ?? null, dirty, fileReadOnly: readOnlyRef })

  // Preview renders Markdown, so it exists only for Markdown files (VS Code's "Open Preview").
  const togglePreview = () => {
    if (!enabled || !loadedRef.current || !isMarkdownExt(ext)) return
    const next = !preview
    if (next && editorRef.current) setPreviewSource(editorRef.current.getValue())
    setPreview(next)
    a.onPreviewChange?.(next)
  }

  /** Satu percobaan tulis; `opts` menentukan seberapa ketat (versi / harus ada). Resolves true only
   *  after the write landed; false when it was refused, failed, or could not start. */
  const doWrite = (opts: { expectedVersion?: FsVersion; mustExist?: boolean }): Promise<boolean> => {
    const editor = editorRef.current
    if (!editor || !loadedRef.current || readOnlyRef.current || savingRef.current || mask.modeRef.current === 'masked') return Promise.resolve(false)
    const value = editor.getValue()
    savingRef.current = true
    setSaving(true)
    return a.writeChecked(pathRef.current, value, opts).then(
      (r) => {
        savingRef.current = false
        setSaving(false)
        if (r.ok) {
          savedRef.current = value
          if (r.version !== undefined) versionRef.current = r.version
          // Bandingkan dengan isi SEKARANG: pengguna mungkin mengetik selagi request berjalan.
          setDirty(editor.getValue() !== value)
          setConflict(null)
          setSaveError('')
          return true
        }
        if (r.code === 'EVERSION') setConflict({ kind: 'version', current: r.current })
        else if (r.code === 'ENOENT') setConflict({ kind: 'missing' })
        else fail('save', `Couldn’t save ${fileName}: ${r.error}`)
        return false
      },
      (err: unknown) => {
        savingRef.current = false
        setSaving(false)
        fail('save', `Couldn’t save ${fileName}: ${errText(err)}`)
        return false
      }
    )
  }

  const save = (): Promise<boolean> => {
    if (!editorRef.current) return Promise.resolve(false)
    // Masked: the buffer is display text and never dirty; nothing may be written.
    if (mask.modeRef.current === 'masked') return Promise.resolve(true)
    // Guard !dirty: ⌘S pada buffer bersih tidak menulis (menghindari mtime berubah & EVERSION palsu).
    if (editorRef.current.getValue() === savedRef.current) return Promise.resolve(true)
    return doWrite({ expectedVersion: versionRef.current, mustExist: true })
  }
  const saveRef = useRef(save)
  saveRef.current = save
  const toggleRef = useRef(togglePreview)
  toggleRef.current = togglePreview

  /** Timpa eksplisit atas pilihan pengguna di bar konflik; buffer pengguna yang menang. */
  const overwrite = () => {
    if (!conflict) return
    void doWrite(conflict.kind === 'version' ? { expectedVersion: conflict.current, mustExist: true } : {})
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
        fail('reload', refusal ?? `${fileName} is no longer UTF-8 text; the buffer was not replaced.`)
        return
      }
      if (onlyIfClean && mask.modeRef.current !== 'masked' && editor.getValue() !== savedRef.current) {
        setConflict({ kind: 'version', current: meta.version })
        return
      }
      savedRef.current = meta.content
      versionRef.current = meta.version
      const text = mask.load(meta.content)
      editor.setValue(text)
      if (previewRef.current) setPreviewSource(text)
      setDirty(false)
      setConflict(null)
      setSaveError('')
    } catch (err) {
      fail('reload', `Couldn’t reload ${fileName}: ${errText(err)}`)
    }
  }

  /** Repeat the save or reload that set `saveError`. */
  const retry = (): void => { void (failedOp === 'reload' ? reload() : save()) }

  /** Read the file again after a load failure (VS Code's "Try Again"). */
  const retryLoad = (): void => setLoadKey((k) => k + 1)

  /** Pandangan sesaat untuk `useEditorSync`: dirty/saving/versi terakhir yang dikenal. */
  const snapshot = () => ({
    dirty: !!editorRef.current && mask.modeRef.current !== 'masked' && editorRef.current.getValue() !== savedRef.current,
    saving: savingRef.current,
    version: versionRef.current
  })

  // Teks: baca dulu (versi + encoding), baru muat Monaco — biner tidak boleh memicu pemuatan Monaco.
  useEffect(() => {
    // Sisa error jenis sebelumnya (rename mengganti jenis) tidak boleh menempel.
    a.setLoadError('')
    setSaveError('')
    if (!enabled || !pathRef.current) return
    // Berganti jenis (mis. rename .txt -> .png lalu balik) = muat ulang bersih, bukan sisa state lama.
    setDirty(false)
    setConflict(null)
    setEncoding('utf8')
    setPreview(false)
    mask.reset()
    const filePath = pathRef.current
    let disposed = false
    let model: MonacoEditor.ITextModel | null = null
    let editor: MonacoEditor.IStandaloneCodeEditor | null = null
    let themeObserver: MutationObserver | null = null
    let saveAction: IDisposable | null = null
    let previewTimer: ReturnType<typeof setTimeout> | undefined

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
        const text = mask.load(meta.content)
        // Satu model per NODE (fragment = id node): dua node pada file yang sama tidak berbagi model.
        const uri = m.Uri.file(filePath).with({ fragment: id })
        model = m.editor.getModel(uri) ?? m.editor.createModel(text, undefined, uri)
        editor = m.editor.create(host, { ...EDITOR_OPTIONS, model, theme: currentMonacoTheme(), readOnly: readOnlyRef.current || mask.modeRef.current === 'masked' })
        // Monaco memegang satu tema global: ikuti pergantian Dark/Light app selama node ini hidup.
        themeObserver = new MutationObserver(() => m.editor.setTheme(currentMonacoTheme()))
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
        editorRef.current = editor
        setLive({ monaco: m, editor })
        savedRef.current = meta.content
        versionRef.current = meta.version
        loadedRef.current = true
        setEncoding(meta.encoding)
        editor.onDidChangeModelContent(() => {
          if (mask.modeRef.current !== 'masked') setDirty(editor!.getValue() !== savedRef.current)
          if (!previewRef.current) return
          clearTimeout(previewTimer)
          previewTimer = setTimeout(() => { if (!disposed && editor) setPreviewSource(editor.getValue()) }, PREVIEW_DEBOUNCE_MS)
        })
        // `addAction`, not `addCommand`: standalone `addCommand` registers a global keybinding (last
        // editor wins, never disposed), while an action's keybinding is scoped to this editor's id, so
        // Cmd+S saves the focused node's file, like VS Code's save on the active editor.
        saveAction = editor.addAction({ id: SAVE_ACTION_ID, label: 'File: Save', keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.KeyS], run: () => { void saveRef.current() } })
        if (opensInPreview(ext, a.openMarkdownPreview)) {
          setPreviewSource(text)
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
      clearTimeout(previewTimer)
      loadedRef.current = false
      themeObserver?.disconnect()
      // The action's registrations live in global registries, not on the editor: dispose them here.
      saveAction?.dispose()
      editor?.dispose()
      // Model dibuang eksplisit: React tidak melepas resource Monaco hanya karena container-nya
      // keluar dari tree, dan model yang tertinggal menahan worker bahasanya (lihat tsWorkerReaper).
      model?.dispose()
      editorRef.current = null
      setLive(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- path lewat pathRef; hanya jenis (enabled) dan Retry (loadKey) yang memuat ulang
  }, [enabled, loadKey])

  // Unsaved-changes registry for the close gate (editorDirty.ts): the save it runs is this node's
  // own, awaited, so "Save" before close only closes once the write landed.
  useEffect(() => {
    setEditorDirty(id, dirty, () => saveRef.current())
  }, [id, dirty])
  useEffect(() => () => setEditorDirty(id, false), [id])

  return { live, dirty, saving, preview, previewSource, mask, encoding, conflict, saveError, retry, retryLoad, togglePreview, toggleRef, save, reload, overwrite, snapshot, flagConflict: setConflict }
}
