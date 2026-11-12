// Registry env: file manager (PLAN/FILEMANAGER-b.md §5.5). Semua flag default ON (L11, minim-.env; MUTATE/UPLOAD ikut
// sejak default maksimal 2026-11-12: hapus = tempat sampah + Undo, jadi tak ada aksi tak terbalikkan); empat perbaikan P0 (create-eksklusif, versi/konflik, body cap, penolakan biner)
// TIDAK di balik flag. Data murni.
// Grup + owner 'files' (envRegistry.groups.ts). Semua restart 'hot': dibaca per panggilan. Hanya saklar mutasi yang 'user'.
import { FILES_LIST_MAX_DEFAULT, FILES_UPLOAD_MAX_MB_DEFAULT } from '../shared/fsLimits'
import { flagOn } from './envFlag'
import { isEnabled } from './featureCapabilities.runtime'
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

/** Flags on in zero-config (L11). Writes too: delete goes to the trash with Undo, so nothing here is irreversible. */
export const FILES_DEFAULT_ON: ReadonlySet<FilesFlag> = new Set<FilesFlag>(['VIEWERS', 'WATCH', 'GIT_STATUS', 'QUICK_OPEN', 'MUTATE', 'UPLOAD'])

/** Default `on|off` satu flag; sumber tunggal untuk spec registry DAN pembaca (RND/53 G6). */
function filesDefault(name: FilesFlag): 'on' | 'off' {
  return FILES_DEFAULT_ON.has(name) ? 'on' : 'off'
}

/** Env dengan default L11 diisi untuk kunci kosong: isEnabled (pembaca tunggal) hanya melihat nilai eksplisit. */
function withFilesDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const name of Object.keys(FILES_FLAG) as FilesFlag[]) {
    const key = FILES_FLAG[name]
    if ((out[key] ?? '').trim() === '') out[key] = filesDefault(name)
  }
  return out
}

/**
 * Apakah flag file manager `on` (dibaca per panggilan lewat isEnabled). Kosong = default flag; nilai eksplisit menang.
 * Baca = `files`; tulis/unggah = `filesWrite` (implies `files`); WATCH/GIT_STATUS/QUICK_OPEN/UPLOAD anak: induk on DAN kunci anak on.
 */
export function filesFlagOn(name: FilesFlag, env: NodeJS.ProcessEnv = process.env): boolean {
  const e = withFilesDefaults(env)
  switch (name) {
    case 'VIEWERS': return isEnabled('files', e)
    case 'MUTATE': return isEnabled('filesWrite', e)
    case 'UPLOAD': return isEnabled('filesWrite', e) && flagOn(e[FILES_FLAG[name]])
    default: return isEnabled('files', e) && flagOn(e[FILES_FLAG[name]])
  }
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

const F = { owner: 'files', section: 'File manager', audience: 'advanced' } as const

export const FILES_ENV_SPECS: readonly EnvSpec[] = [
  flag(FILES_FLAG.MUTATE, 'files', { ...F, audience: 'user', label: 'Files: mutations', description: 'Delete (trash + Undo), restore, rename, and copy in files nodes.', hot: true }, filesDefault('MUTATE')),
  flag(FILES_FLAG.VIEWERS, 'files', { ...F, label: 'Files: viewer', description: 'Raw endpoint + image/audio/video/PDF viewers. Off: non-text files show as a placeholder.', hot: true }, filesDefault('VIEWERS')),
  flag(FILES_FLAG.WATCH, 'files', { ...F, label: 'Files: watcher', description: 'Syncs listings/editors when files change outside webterm.', hot: true }, filesDefault('WATCH')),
  flag(FILES_FLAG.GIT_STATUS, 'files', { ...F, label: 'Files: git status', description: 'Git status decorations (M/A/U/...) in the file list.', hot: true }, filesDefault('GIT_STATUS')),
  flag(FILES_FLAG.QUICK_OPEN, 'files', { ...F, label: 'Files: Quick Open', description: 'File search (Ctrl/Cmd+P) while a files node is focused.', hot: true }, filesDefault('QUICK_OPEN')),
  flag(FILES_FLAG.UPLOAD, 'files', { ...F, label: 'Files: upload/download', description: 'Upload to and download from files nodes.', hot: true }, filesDefault('UPLOAD')),
  num(LIST_MAX_KEY, 'files', 100, 100000, FILES_LIST_MAX_DEFAULT, { ...F, unit: 'entries', label: 'Files: entry limit', description: 'Max entries in one directory listing; the rest are truncated.', hot: true }),
  num(UPLOAD_MAX_KEY, 'files', 1, 10240, FILES_UPLOAD_MAX_MB_DEFAULT, { ...F, unit: 'MB', label: 'Files: upload limit (MB)', description: 'Maximum size of one uploaded file.', hot: true }),
]
