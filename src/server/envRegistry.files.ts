// Registry env: file manager (PLAN/FILEMANAGER-b.md §5.5). Semua flag OFF; empat perbaikan P0
// (create-eksklusif, versi/konflik, body cap, penolakan biner) TIDAK di balik flag. Data murni.
// Grup 'control': EnvGroup/ENV_GROUP_ORDER bukan milik WS-FM-00, dan menambah grup = ubah UI Pengaturan.
import { FILES_LIST_MAX_DEFAULT, FILES_UPLOAD_MAX_MB_DEFAULT } from '../shared/fsLimits'
import { flagOn } from './envFlag'
import { flag, num, type EnvSpec } from './envRegistry.types'

/** Nama env tiap flag; kunci = nama flag di dispatcher (`fsApi.ts`) dan cabang ws (`index.ts`). */
export const FILES_FLAG = {
  MUTATE: 'WEBTERM_FILES_MUTATE',
  VIEWERS: 'WEBTERM_FILES_VIEWERS',
  WATCH: 'WEBTERM_FILES_WATCH',
  GIT_STATUS: 'WEBTERM_FILES_GIT_STATUS',
  QUICK_OPEN: 'WEBTERM_FILES_QUICK_OPEN',
  UPLOAD: 'WEBTERM_FILES_UPLOAD',
} as const
export type FilesFlag = keyof typeof FILES_FLAG

const LIST_MAX_KEY = 'WEBTERM_FILES_LIST_MAX'
const UPLOAD_MAX_KEY = 'WEBTERM_FILES_UPLOAD_MAX_MB'

/** Apakah flag file manager `on` (dibaca per panggilan, jadi perubahan dari Pengaturan langsung berlaku). */
export function filesFlagOn(name: FilesFlag, env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[FILES_FLAG[name]])
}

function positiveInt(raw: string | undefined, def: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : def
}

/** Cap jumlah entri `list-v2` (`truncated` di atasnya). */
export function filesListMax(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env[LIST_MAX_KEY], FILES_LIST_MAX_DEFAULT)
}

/** Cap ukuran upload dalam byte. */
export function filesUploadMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env[UPLOAD_MAX_KEY], FILES_UPLOAD_MAX_MB_DEFAULT) * 1024 * 1024
}

export const FILES_ENV_SPECS: readonly EnvSpec[] = [
  flag(FILES_FLAG.MUTATE, 'control', { label: 'Files: mutasi', description: 'Delete (trash + Undo), restore, rename, copy di node files.', hot: true }),
  flag(FILES_FLAG.VIEWERS, 'control', { label: 'Files: viewer', description: 'Endpoint raw + viewer gambar/audio/video/PDF. Mati: file non-teks tampil sebagai placeholder.', hot: true }),
  flag(FILES_FLAG.WATCH, 'control', { label: 'Files: watcher', description: 'Sinkronisasi listing/editor saat file berubah di luar webterm.', hot: true }),
  flag(FILES_FLAG.GIT_STATUS, 'control', { label: 'Files: status git', description: 'Dekorasi status git (M/A/U/...) pada daftar file.', hot: true }),
  flag(FILES_FLAG.QUICK_OPEN, 'control', { label: 'Files: Quick Open', description: 'Pencarian file (Ctrl/Cmd+P) saat node files fokus.', hot: true }),
  flag(FILES_FLAG.UPLOAD, 'control', { label: 'Files: upload/download', description: 'Upload ke dan download dari node files.', hot: true }),
  num(LIST_MAX_KEY, 'control', 100, 100000, FILES_LIST_MAX_DEFAULT, { label: 'Files: batas entri', description: 'Maks entri satu listing direktori; selebihnya dipotong (truncated).', hot: true }),
  num(UPLOAD_MAX_KEY, 'control', 1, 10240, FILES_UPLOAD_MAX_MB_DEFAULT, { label: 'Files: batas upload (MB)', description: 'Ukuran maksimum satu file upload.', hot: true }),
]
