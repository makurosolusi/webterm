// Slot upload/download file manager (WS-FM-10): menu "Upload…"/"Download", drop file OS ke node, dan
// status progres/ringkasan di toolbar. Semua dikunci `capabilities().upload` (fail-closed).
// Drop dipasang lewat `useSlot` pada elemen node React Flow (`[data-id=nodeId]`) karena kontrak
// FilesSlot belum punya `onDrop`; integrasi nanti cukup memanggil `runUpload` dari slot itu.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { childPath } from './fileBrowse'
import { capabilities } from './fsClient'
import type { FilesSlot, FilesSlotCtx } from './filesSlots'
import { downloadUrl, uploadFiles, type UploadSummary } from './uploadQueue'

/** Satu-satunya tempat string UI slot ini (Indonesia). */
export const UPLOAD_TEXT = {
  menuUpload: 'Upload…',
  menuDownload: 'Download',
  busy: 'Upload sebelumnya masih berjalan.',
  folderSkipped: 'Folder tidak bisa diunggah, dilewati: ',
  summary: (ok: number, fail: number) => `${ok} berhasil${fail ? `, ${fail} gagal` : ''}`,
  progress: (i: number, n: number, pct: number) => `Mengunggah ${i}/${n} · ${pct}%`,
  dismiss: 'Tutup ringkasan upload',
}

interface Status { running: boolean; index: number; total: number; pct: number; name: string; summary: UploadSummary | null; note: string }
const IDLE: Status = { running: false, index: 0, total: 0, pct: 0, name: '', summary: null, note: '' }
let status: Status = IDLE
const subs = new Set<() => void>()
const setStatus = (s: Status) => { status = s; subs.forEach((f) => f()) }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
let uploadEnabled = false
/** Download memakai `raw`, yang dikunci flag VIEWERS selain UPLOAD. */
let downloadEnabled = false

/** Status upload saat ini (untuk tes). */
export const uploadStatus = (): Status => status
/** Kembalikan state modul ke awal (untuk tes). */
export function resetUploadSlot(): void { status = IDLE; uploadEnabled = false; downloadEnabled = false; subs.clear() }

/** Jalankan antrean upload ke `dir`; `onDone` (mis. refresh) dipanggil bila ada yang sukses. Tolak bila masih berjalan. */
export async function runUpload(dir: string, files: readonly File[], onDone: () => void, note = ''): Promise<void> {
  if (status.running) { setStatus({ ...status, note: UPLOAD_TEXT.busy }); return }
  if (files.length === 0) { if (note) setStatus({ ...IDLE, note }); return }
  setStatus({ ...IDLE, running: true, total: files.length, name: files[0].name, note })
  const summary = await uploadFiles(dir, files, {
    onStart: (i, name, total) => setStatus({ ...status, index: i + 1, total, name, pct: 0 }),
    onProgress: (_i, loaded, total) => setStatus({ ...status, pct: total ? Math.round((loaded / total) * 100) : 0 }),
  })
  setStatus({ ...IDLE, summary, note })
  if (summary.ok.length) onDone()
}

function pickFiles(onPick: (files: File[]) => void): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.hidden = true
  input.onchange = () => { onPick([...(input.files ?? [])]) }
  input.click()
}

/** Unduh lewat tautan `download` sementara: tanpa membuka tab, tanpa meninggalkan halaman. */
function download(path: string, name: string): void {
  const a = document.createElement('a')
  a.href = downloadUrl(path)
  a.download = name
  a.hidden = true
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** File dari event drop OS; folder (entri direktori) dilewati dan namanya dikembalikan terpisah. */
export function filesFromDrop(dt: DataTransfer): { files: File[]; skipped: string[] } {
  const files: File[] = []
  const skipped: string[] = []
  const items = [...(dt.items ?? [])].filter((it) => it.kind === 'file')
  if (items.length === 0) return { files: [...dt.files], skipped }
  for (const it of items) {
    const f = it.getAsFile()
    if (!f) continue
    if (it.webkitGetAsEntry?.()?.isDirectory) skipped.push(f.name)
    else files.push(f)
  }
  return { files, skipped }
}

function UploadStatusView() {
  const s = useSyncExternalStore(subscribe, () => status)
  if (s.running) return <span role="status" title={s.name}>{UPLOAD_TEXT.progress(s.index, s.total, s.pct)}</span>
  if (!s.summary && !s.note) return null
  const title = [...(s.summary?.failed.map((f) => f.message) ?? []), s.note].filter(Boolean).join('\n')
  const text = s.summary ? UPLOAD_TEXT.summary(s.summary.ok.length, s.summary.failed.length) : s.note
  return (
    <button type="button" className="files-tool" role="status" title={title} aria-label={`${text}. ${UPLOAD_TEXT.dismiss}`} onClick={() => setStatus(IDLE)}>
      {text}
    </button>
  )
}

/** Pasang drop file OS pada node; hanya bereaksi pada drag yang membawa `Files` (DnD path internal lewat). */
function useDrop(ctx: FilesSlotCtx, on: boolean): void {
  const live = useRef(ctx)
  live.current = ctx
  useEffect(() => {
    const el = on ? document.querySelector<HTMLElement>(`[data-id="${CSS.escape(ctx.nodeId)}"]`) : null
    if (!el) return
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const over = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy' } }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return
      e.preventDefault()
      e.stopPropagation()
      const { files, skipped } = filesFromDrop(e.dataTransfer)
      const c = live.current
      void runUpload(c.dir, files, c.refresh, skipped.length ? UPLOAD_TEXT.folderSkipped + skipped.join(', ') : '')
    }
    el.addEventListener('dragover', over)
    el.addEventListener('drop', drop)
    return () => { el.removeEventListener('dragover', over); el.removeEventListener('drop', drop) }
  }, [on, ctx.nodeId])
}

export const uploadSlot: FilesSlot = {
  id: 'upload',
  useSlot(ctx) {
    const [on, setOn] = useState(uploadEnabled)
    useEffect(() => {
      let alive = true
      // Promise.resolve().then: `capabilities` yang melempar sinkron tetap jadi penolakan, bukan merobohkan FilesNode.
      Promise.resolve().then(() => capabilities()).then((c) => {
        uploadEnabled = c.upload; downloadEnabled = c.upload && c.viewers
        if (alive) setOn(c.upload)
      }).catch((err: unknown) => {
        uploadEnabled = false; downloadEnabled = false // fail-closed
        console.error('files upload slot: capabilities failed, upload disabled', err)
        if (alive) setOn(false)
      })
      return () => { alive = false }
    }, [])
    useDrop(ctx, on)
  },
  menu(ctx) {
    if (!uploadEnabled) return []
    const rows = [{ label: UPLOAD_TEXT.menuUpload, onClick: () => pickFiles((f) => { void runUpload(ctx.dir, f, ctx.refresh) }) }]
    const file = ctx.selection.length === 1 ? ctx.entries.find((e) => e.name === ctx.selection[0] && !e.dir) : undefined
    if (file && downloadEnabled) rows.push({ label: UPLOAD_TEXT.menuDownload, onClick: () => download(childPath(ctx.dir, file.name), file.name) })
    return rows
  },
  toolbar: () => (uploadEnabled ? <UploadStatusView /> : null),
}
