// Antrean upload file manager (WS-FM-10): satu file per request, berurutan, progres per file, galat
// satu file tidak menghentikan sisanya. Transport = XMLHttpRequest karena `fetch` belum punya event
// progres unggah yang andal lintas browser; hanya `xhrUpload` yang menyentuh jaringan (diganti di tes).
// `createUploadQueue` is one FIFO per Files node: jobs added while a batch runs join that batch, an
// EEXIST asks Replace / Skip / Keep Both, Cancel aborts the current request and drops the rest.
import { fsFail, type FsErrCode, type FsFail, type FsResult } from '../shared/fsContract'
import { childPath } from './fileBrowse'
import { copyName } from './filesName'
import { emitFsEvent } from './fsEvents'
import { rawUrl } from './fsClient'

/** Satu-satunya tempat string galat upload/download (Inggris); kode tak terdaftar jatuh ke `EIO`. */
export const UPLOAD_MSG: Partial<Record<FsErrCode, string>> & { EIO: string } = {
  EEXIST: 'already exists in this folder (not overwritten)',
  ETOOLARGE: 'exceeds the upload size limit',
  EINVAL: 'invalid file name',
  ENAMETOOLONG: 'file name is too long',
  ENOENT: 'destination folder does not exist',
  ENOTDIR: 'destination is not a folder',
  EACCES: 'no permission to write to this folder',
  EROFS: 'folder is read-only',
  ENOSPC: 'disk is full',
  EDISABLED: 'the “Edit and upload files” capability is off',
  EIO: 'upload failed (network or server)',
}

/** Teks galat satu file: `nama: alasan`. */
export function uploadErrorText(name: string, f: FsFail): string {
  return `${name}: ${UPLOAD_MSG[f.code] ?? UPLOAD_MSG.EIO}`
}

/** `overwrite` replaces an existing regular file (server contract C1); `signal` aborts the request. */
export interface SendOpts { overwrite?: boolean; signal?: AbortSignal }
export type UploadSender = (dir: string, name: string, file: Blob, onProgress: (loaded: number, total: number) => void, opts?: SendOpts) => Promise<FsResult>

type Body = { ok?: unknown; code?: unknown } | null
function parseBody(text: string): Body {
  try {
    return JSON.parse(text) as Body
  } catch {
    return null // bukan JSON (halaman error proxy): pemanggil melaporkan status HTTP
  }
}

/** Upload satu file lewat XHR; tak pernah menolak (jaringan/JSON rusak -> `EIO`). */
export const xhrUpload: UploadSender = (dir, name, file, onProgress, opts = {}) =>
  new Promise((resolve) => {
    const params = new URLSearchParams({ dir, name, ...(opts.overwrite ? { overwrite: '1' } : {}) })
    const q = params.toString()
    const xhr = new XMLHttpRequest()
    const fail = (why: string) => resolve(fsFail('EIO', `fs upload ${name}: ${why}`))
    if (opts.signal?.aborted) { fail('aborted'); return }
    opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.open('POST', `/api/fs/upload?${q}`)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total) }
    xhr.onerror = () => fail('network error')
    xhr.onabort = () => fail('aborted')
    xhr.onload = () => {
      const json = parseBody(xhr.responseText)
      if (json?.ok === true) resolve(json as FsResult)
      else if (json?.ok === false && typeof json.code === 'string') resolve(json as FsFail)
      else fail(`HTTP ${xhr.status}`)
    }
    xhr.send(file)
  })

/** URL unduhan sebuah file: `raw` + `download=1` (server menambah Content-Disposition attachment). */
export function downloadUrl(path: string): string {
  return `${rawUrl(path)}&download=1`
}

export interface UploadJob { dir: string; file: File }
export type ConflictChoice = 'replace' | 'skip' | 'keep'
export interface ConflictAnswer { choice: ConflictChoice; all: boolean }
/** `remaining` = files still queued after this one (the "apply to all" checkbox only matters then). */
export interface ConflictAsk { name: string; dir: string; remaining: number }
export interface UploadFailure { job: UploadJob; code: FsErrCode; message: string }
/** Byte progress over the whole batch; `index` is 1-based. */
export interface UploadProgress { index: number; total: number; name: string; loaded: number; bytes: number }
export interface UploadOutcome { ok: string[]; skipped: string[]; failed: UploadFailure[]; cancelled: boolean }
export interface UploadQueueHooks {
  onProgress(p: UploadProgress): void
  ask(c: ConflictAsk): Promise<ConflictAnswer>
  onDone(o: UploadOutcome): void
}
export interface UploadQueue { add(jobs: readonly UploadJob[]): void; cancel(): void; readonly running: boolean }

/** Cap on "Keep Both" names tried for one file before it is reported as EEXIST. */
export const KEEP_BOTH_TRIES = 100

interface Batch {
  index: number; total: number; done: number; bytes: number
  ok: string[]; skipped: string[]; failed: UploadFailure[]; policy: ConflictChoice | null; cancelled: boolean
}
const freshBatch = (): Batch => ({ index: 0, total: 0, done: 0, bytes: 0, ok: [], skipped: [], failed: [], policy: null, cancelled: false })

/** One FIFO upload queue; never rejects a job because another is running. */
export function createUploadQueue(hooks: UploadQueueHooks, send: UploadSender = xhrUpload): UploadQueue {
  let pending: UploadJob[] = []
  let running = false
  let b = freshBatch()
  let abort = new AbortController()
  /** Re-emit the current file's progress (a job joined the batch, so `total`/`bytes` changed). */
  let retick = () => {}

  async function one(job: UploadJob): Promise<void> {
    abort = new AbortController()
    let last = 0
    const tick = (loaded: number) => {
      last = loaded
      hooks.onProgress({ index: b.index, total: b.total, name: job.file.name, loaded: b.done + loaded, bytes: b.bytes })
    }
    retick = () => tick(last)
    const put = (name: string, overwrite: boolean) => send(job.dir, name, job.file, tick, { overwrite, signal: abort.signal })
    tick(0)
    let name = job.file.name
    let r = await put(name, false)
    if (!r.ok && r.code === 'EEXIST' && !b.cancelled) {
      let choice = b.policy
      if (!choice) {
        const a = await hooks.ask({ name, dir: job.dir, remaining: pending.length })
        choice = a.choice
        if (a.all) b.policy = a.choice
      }
      if (choice === 'skip') { b.skipped.push(name); return }
      if (choice === 'replace') r = await put(name, true)
      const taken = [name]
      for (let i = 0; choice === 'keep' && i < KEEP_BOTH_TRIES && !r.ok && r.code === 'EEXIST' && !b.cancelled; i++) {
        name = copyName(job.file.name, taken)
        taken.push(name)
        r = await put(name, false)
      }
    }
    if (r.ok) {
      b.ok.push(name)
      emitFsEvent({ kind: 'created', path: childPath(job.dir, name), origin: 'local' })
    } else if (!b.cancelled) {
      b.failed.push({ job, code: r.code, message: uploadErrorText(name, r) })
    }
  }

  async function pump(): Promise<void> {
    running = true
    while (pending.length && !b.cancelled) {
      const job = pending.shift() as UploadJob
      b.index++
      await one(job)
      b.done += job.file.size
    }
    const done = b
    b = freshBatch()
    running = false
    retick = () => {}
    hooks.onDone({ ok: done.ok, skipped: done.skipped, failed: done.failed, cancelled: done.cancelled })
  }

  return {
    get running() { return running },
    add(jobs) {
      if (!jobs.length) return
      pending.push(...jobs)
      b.total += jobs.length
      b.bytes += jobs.reduce((n, j) => n + j.file.size, 0)
      if (running) retick()
      else void pump()
    },
    cancel() {
      if (!running) return
      b.cancelled = true
      pending = []
      abort.abort()
    },
  }
}
