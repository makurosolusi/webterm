// Antrean upload file manager (WS-FM-10): satu file per request, berurutan, progres per file, galat
// satu file tidak menghentikan sisanya. Transport = XMLHttpRequest karena `fetch` belum punya event
// progres unggah yang andal lintas browser; hanya `xhrUpload` yang menyentuh jaringan (diganti di tes).
import { fsFail, type FsErrCode, type FsFail, type FsResult } from '../shared/fsContract'
import { tokenQuery } from './api'
import { childPath } from './fileBrowse'
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

export interface UploadHooks {
  onStart?(index: number, name: string, total: number): void
  /** loaded/total dalam byte untuk file ke-`index`. */
  onProgress?(index: number, loaded: number, total: number): void
  onFileDone?(index: number, name: string, result: FsResult): void
}
export interface UploadSummary { ok: string[]; failed: Array<{ name: string; code: FsErrCode; message: string }> }
export type UploadSender = (dir: string, name: string, file: Blob, onProgress: (loaded: number, total: number) => void) => Promise<FsResult>

type Body = { ok?: unknown; code?: unknown } | null
function parseBody(text: string): Body {
  try {
    return JSON.parse(text) as Body
  } catch {
    return null // bukan JSON (halaman error proxy): pemanggil melaporkan status HTTP
  }
}

/** Upload satu file lewat XHR; tak pernah menolak (jaringan/JSON rusak -> `EIO`). */
export const xhrUpload: UploadSender = (dir, name, file, onProgress) =>
  new Promise((resolve) => {
    const q = [new URLSearchParams({ dir, name }).toString(), tokenQuery()].filter(Boolean).join('&')
    const xhr = new XMLHttpRequest()
    const fail = (why: string) => resolve(fsFail('EIO', `fs upload: ${why}`))
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

/**
 * Upload `files` ke `dir` satu per satu. Sukses memancarkan `emitFsEvent(created)`; galat satu file
 * dicatat di ringkasan dan antrean lanjut. Nama bentrok ditolak server (EEXIST), tak pernah ditimpa.
 */
export async function uploadFiles(dir: string, files: readonly File[], hooks: UploadHooks = {}, send: UploadSender = xhrUpload): Promise<UploadSummary> {
  const summary: UploadSummary = { ok: [], failed: [] }
  for (const [i, file] of files.entries()) {
    hooks.onStart?.(i, file.name, files.length)
    const r = await send(dir, file.name, file, (loaded, total) => hooks.onProgress?.(i, loaded, total))
    if (r.ok) {
      summary.ok.push(file.name)
      emitFsEvent({ kind: 'created', path: childPath(dir, file.name), origin: 'local' })
    } else {
      summary.failed.push({ name: file.name, code: r.code, message: uploadErrorText(file.name, r) })
    }
    hooks.onFileDone?.(i, file.name, r)
  }
  return summary
}

/** URL unduhan sebuah file: `raw` + `download=1` (server menambah Content-Disposition attachment). */
export function downloadUrl(path: string): string {
  return `${rawUrl(path)}&download=1`
}
