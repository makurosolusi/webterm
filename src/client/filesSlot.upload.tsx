// Slot upload/download file manager (WS-FM-10): menu "Upload…"/"Download", "Upload Files…" in the
// title-bar overflow menu, OS file drop onto the node (filesSlot.upload.drop), one FIFO queue per node (uploadQueue),
// the "already exists" prompt (filesSlot.upload.conflict). Progress and results go through
// `ctx.notify` (footer + progress bar), never the toolbar. Everything is gated by
// `capabilities().upload` (fail-closed); with filesWrite off "Upload…" shows locked and offers to turn it on.
import { useEffect, useState } from 'react'
import { childPath } from './fileBrowse'
import { codicon } from './FilesMenu'
import { capabilities } from './fsClient'
import type { NoticeAction } from './filesNotice'
import { UploadConflictDialog, askConflict, resetUploadConflicts, skipUploadConflict } from './filesSlot.upload.conflict'
import { filesFromDrop, useUploadDrop } from './filesSlot.upload.drop'
import type { FilesSlot, FilesSlotCtx } from './filesSlots'
import { lockedRow, offerFilesWrite, useFilesWriteEpoch, WRITE_OFFER_TEXT } from './filesWriteOffer'
import { createUploadQueue, downloadUrl, type UploadOutcome, type UploadQueue } from './uploadQueue'

const nFiles = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`

/** Satu-satunya tempat string UI slot ini (Inggris). */
export const UPLOAD_TEXT = {
  menuUpload: 'Upload…',
  menuDownload: 'Download',
  toolbarUpload: 'Upload Files…',
  folderSkipped: 'Folders can’t be uploaded, skipped: ',
  progress: (i: number, n: number, name: string) => `Uploading ${i} of ${n} · ${name}`,
  done: (ok: number, skipped: number) =>
    ok ? `${nFiles(ok)} uploaded${skipped ? `, ${skipped} skipped` : ''}` : `${nFiles(skipped)} skipped`,
  failed: (failed: number, total: number, reasons: readonly string[]) => `${failed} of ${nFiles(total)} failed — ${reasons.join('; ')}`,
  cancelled: (ok: number) => (ok ? `Upload cancelled · ${nFiles(ok)} uploaded` : 'Upload cancelled'),
  retry: 'Retry Failed Uploads',
  dropHint: (folder: string) => `Drop to upload to ${folder}`,
}

/** Notice ids of this slot: the running/finished batch, and the "folders skipped" note of a drop. */
export const UPLOAD_NOTICE = 'upload'
export const FOLDERS_NOTICE = 'upload-folders'

let uploadEnabled = false
/** Download memakai `raw`, yang dikunci flag VIEWERS selain UPLOAD. */
let downloadEnabled = false
/** Upload mati KARENA filesWrite mati (bisa dinyalakan dari tawaran); mati karena galat tetap tersembunyi. */
let uploadLocked = false
/** Per node: its queue, and the latest ctx (refresh/notify of the node as it is now). */
const queues = new Map<string, UploadQueue>()
const latest = new Map<string, FilesSlotCtx>()

/** Kembalikan state modul ke awal (untuk tes). */
export function resetUploadSlot(): void {
  queues.forEach((q) => q.cancel())
  resetUploadConflicts()
  queues.clear(); latest.clear()
  uploadEnabled = false; downloadEnabled = false; uploadLocked = false
}

/**
 * Node `nodeId` is gone: abort its running upload, answer its open conflict Skip, drop its queue.
 * `latest` goes first, so the cancelled batch's progress/done callbacks post nothing afterwards.
 */
export function forgetUploads(nodeId: string): void {
  latest.delete(nodeId)
  queues.get(nodeId)?.cancel()
  queues.delete(nodeId)
  skipUploadConflict(nodeId)
}

function finish(nodeId: string, o: UploadOutcome): void {
  const ctx = latest.get(nodeId)
  if (!ctx) return
  if (o.ok.length) ctx.refresh()
  if (o.failed.length) {
    const actions: NoticeAction[] = [{ label: UPLOAD_TEXT.retry, icon: 'refresh', run: () => queueFor(nodeId).add(o.failed.map((f) => f.job)) }]
    // Rejected EDISABLED (turned off after the slot loaded): offer the way out next to Retry.
    if (o.failed.some((f) => f.code === 'EDISABLED')) actions.unshift({ label: WRITE_OFFER_TEXT.enableAction, icon: 'unlock', run: () => offerFilesWrite(nodeId) })
    const reasons = o.failed.map((f) => f.message)
    const total = o.ok.length + o.skipped.length + o.failed.length
    ctx.notify({ id: UPLOAD_NOTICE, kind: 'error', text: UPLOAD_TEXT.failed(o.failed.length, total, reasons), detail: reasons.join('\n'), actions })
  } else if (o.cancelled) {
    ctx.notify({ id: UPLOAD_NOTICE, kind: 'info', text: UPLOAD_TEXT.cancelled(o.ok.length) })
  } else if (o.ok.length || o.skipped.length) {
    ctx.notify({ id: UPLOAD_NOTICE, kind: 'info', text: UPLOAD_TEXT.done(o.ok.length, o.skipped.length) })
  } else {
    ctx.dismiss(UPLOAD_NOTICE)
  }
}

function queueFor(nodeId: string): UploadQueue {
  let q = queues.get(nodeId)
  if (!q) {
    q = createUploadQueue({
      onProgress: (p) => latest.get(nodeId)?.notify({
        id: UPLOAD_NOTICE, kind: 'progress', text: UPLOAD_TEXT.progress(p.index, p.total, p.name),
        progress: p.bytes ? p.loaded / p.bytes : 0, onCancel: () => queueFor(nodeId).cancel(),
      }),
      ask: (c) => askConflict(nodeId, c),
      onDone: (o) => finish(nodeId, o),
    })
    queues.set(nodeId, q)
  }
  return q
}

/** Queue `picked` for upload into `dir` on node `ctx.nodeId`; joins a running batch, never rejected. */
export function runUpload(ctx: FilesSlotCtx, dir: string, picked: readonly File[]): void {
  latest.set(ctx.nodeId, ctx)
  queueFor(ctx.nodeId).add(picked.map((file) => ({ dir, file })))
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

function onDrop(ctx: FilesSlotCtx, dir: string, dt: DataTransfer): void {
  const { files: dropped, skipped } = filesFromDrop(dt)
  if (skipped.length) ctx.notify({ id: FOLDERS_NOTICE, kind: 'error', text: UPLOAD_TEXT.folderSkipped + skipped.join(', ') })
  runUpload(ctx, dir, dropped)
}

const pickInto = (ctx: FilesSlotCtx) => pickFiles((f) => runUpload(ctx, ctx.dir, f))

export const uploadSlot: FilesSlot = {
  id: 'upload',
  useSlot(ctx) {
    latest.set(ctx.nodeId, ctx)
    const [on, setOn] = useState(uploadEnabled)
    const epoch = useFilesWriteEpoch()
    useEffect(() => {
      let alive = true
      // Promise.resolve().then: `capabilities` yang melempar sinkron tetap jadi penolakan, bukan merobohkan FilesNode.
      Promise.resolve().then(() => capabilities()).then((c) => {
        uploadEnabled = c.upload; downloadEnabled = c.upload && c.viewers; uploadLocked = !c.mutate
        if (alive) setOn(c.upload)
      }).catch((err: unknown) => {
        uploadEnabled = false; downloadEnabled = false; uploadLocked = false // fail-closed
        console.error('files upload slot: capabilities failed, upload disabled', err)
        if (alive) setOn(false)
      })
      return () => { alive = false }
    }, [epoch])
    // Unmount = node removed: the tab-layout portal (withTabPortal) keeps this subtree mounted across
    // canvas/tab moves, so this runs only when the node leaves the board (same as mutate's clearUi).
    useEffect(() => () => forgetUploads(ctx.nodeId), [ctx.nodeId])
    useUploadDrop(ctx, on, UPLOAD_TEXT.dropHint, onDrop)
  },
  menu(ctx) {
    if (!uploadEnabled) return uploadLocked ? [lockedRow(ctx.nodeId, UPLOAD_TEXT.menuUpload)] : []
    const rows = [{ label: UPLOAD_TEXT.menuUpload, onClick: () => pickInto(ctx) }]
    const file = ctx.selection.length === 1 ? ctx.entries.find((e) => e.name === ctx.selection[0] && !e.dir) : undefined
    if (file && downloadEnabled) rows.push({ label: UPLOAD_TEXT.menuDownload, onClick: () => download(childPath(ctx.dir, file.name), file.name) })
    return rows
  },
  overflow: (ctx) => (uploadEnabled ? [{ label: UPLOAD_TEXT.toolbarUpload, icon: codicon('cloud-upload'), onClick: () => pickInto(ctx) }] : []),
  overlay: (ctx) => <UploadConflictDialog nodeId={ctx.nodeId} />,
}
