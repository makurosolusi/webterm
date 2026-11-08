// Seluruh teks UI mutasi file manager (menu, dialog, toast) dan SATU peta kode galat -> kalimat.
// Komponen dan alur tidak boleh menulis kalimat sendiri; tambah/ubah di sini.
import type { FsErrCode, FsFail } from '../shared/fsContract'
import type { NameProblem } from './filesName'
import { isAuthFail } from './filesView'

/** Kata kerja mutasi untuk kalimat galat: "Could not <aksi> “nama”". */
export type MutateAction = 'delete' | 'rename' | 'duplicate' | 'restore' | 'copy' | 'move' | 'undo'
const ACTION_WORD: Record<MutateAction, string> = {
  delete: 'delete', rename: 'rename', duplicate: 'duplicate', restore: 'restore', copy: 'copy', move: 'move', undo: 'undo',
}

/** Alasan per kode galat (satu-satunya peta; `Record` penuh = kode baru di kontrak memaksa kalimat baru). */
const REASON: Record<FsErrCode, (name: string) => string> = {
  ENOENT: () => 'Item not found; it may have been moved or deleted.',
  EEXIST: (n) => `The name “${n}” is already taken in this folder.`,
  EACCES: () => 'Permission denied for the account running the server.',
  EROFS: () => 'This location is read-only.',
  EISDIR: () => 'This item is a folder, not a file.',
  ENOTDIR: () => 'Part of the path is not a folder.',
  EINVAL: () => 'Invalid operation, such as moving a folder into itself or using an invalid name.',
  ENAMETOOLONG: () => 'Name is too long (maximum 255 bytes).',
  ENOSPC: () => 'The disk is full.',
  ENOTEMPTY: () => 'The destination folder is not empty.',
  EXDEV: () => 'Items can’t be moved across volumes.',
  EVERSION: () => 'The contents changed since the file was opened.',
  ETOOLARGE: () => 'The size exceeds the limit.',
  EBINARY: () => 'This item is a binary file.',
  EDISABLED: () => 'The “Edit and upload files” capability is turned off.',
  EIO: () => 'An error occurred while accessing the disk or network.',
}
const REASON_AUTH = 'Session rejected (401). Reload the page or sign in again.'
/** Pemulihan ke tempat asal yang sudah terisi: EEXIST bermakna lain daripada saat rename. */
const REASON_RESTORE_EXISTS = 'Another item already exists at the original location, so it was not overwritten.'

/** Alasan satu `FsFail` dalam bahasa jelas; 401 (terselubung sebagai EIO oleh fsClient) dikenali. */
export function failReason(fail: Pick<FsFail, 'code' | 'error'>, name: string, action?: MutateAction): string {
  if (isAuthFail(fail)) return REASON_AUTH
  if (action === 'restore' && fail.code === 'EEXIST') return REASON_RESTORE_EXISTS
  return REASON[fail.code](name)
}

/** Kalimat lengkap satu kegagalan: "Could not delete “a”. <alasan>". */
export function failText(action: MutateAction, name: string, fail: Pick<FsFail, 'code' | 'error'>, subject = name): string {
  // `subject` = nama yang dirujuk alasan (rename EEXIST menyebut nama TUJUAN, bukan nama sumber).
  return `Could not ${ACTION_WORD[action]} “${name}”. ${failReason(fail, subject, action)}`
}

const PROBLEM: Record<NameProblem, string> = {
  empty: 'Name can’t be empty.',
  reserved: 'The names “.” and “..” can’t be used.',
  slash: 'Name can’t contain a slash (/ or \\).',
  nul: 'Name contains a forbidden character.',
  long: 'Name is too long (maximum 255 bytes).',
}
/** Pesan validasi nama untuk input rename. */
export const nameProblemText = (p: NameProblem): string => PROBLEM[p]

/** Last segment of a row path ("src/a.ts" -> "a.ts"): messages name the file, not its tree path. */
const leaf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const items = (n: number, first: string): string => (n === 1 ? `“${leaf(first)}”` : `${n} items`)

/** File names for a list of row paths; the folder is added only where two rows share a name. */
export function displayNames(paths: readonly string[]): string[] {
  const count = new Map<string, number>()
  for (const p of paths) count.set(leaf(p), (count.get(leaf(p)) ?? 0) + 1)
  return paths.map((p) => {
    const i = p.lastIndexOf('/')
    return (count.get(leaf(p)) ?? 0) > 1 && i > 0 ? `${leaf(p)} (${p.slice(0, i)})` : leaf(p)
  })
}

export const MENU = {
  rename: 'Rename…', duplicate: 'Duplicate', trash: 'Delete', permanent: 'Delete Permanently…',
  cut: 'Cut', copy: 'Copy', paste: 'Paste', undo: 'Undo',
} as const
export const KEYS = {
  rename: 'F2', trash: 'Delete', permanent: '⇧Delete', cut: '⌘X', copy: '⌘C', paste: '⌘V', undo: '⌘Z',
} as const

export const CONFIRM = {
  cancel: 'Cancel',
  trashTitle: (n: number, first: string) => `Move ${items(n, first)} to Trash?`,
  trashBody: 'You can restore with Undo for a few seconds afterwards.',
  trashOk: 'Move to Trash',
  permTitle: (n: number, first: string) => `Permanently delete ${items(n, first)}?`,
  permBody: 'This action can’t be undone.',
  permOk: 'Delete Permanently',
} as const

export const TOAST = {
  undo: 'Undo',
  trashed: (n: number, first: string) => `Moved ${items(n, first)} to Trash.`,
  deleted: (n: number, first: string) => `Permanently deleted ${items(n, first)}.`,
  duplicated: (n: number, first: string) => `Duplicated ${items(n, first)}.`,
  restored: (n: number, first: string) => `Restored ${items(n, first)}.`,
  pasted: (n: number, first: string) => `Pasted ${items(n, first)}.`,
  moved: (n: number, first: string) => `Moved ${items(n, first)}.`,
  undone: (n: number, first: string) => `Undid the change to ${items(n, first)}.`,
  nothingToUndo: 'Nothing to undo.',
  failedSome: (failed: number, total: number) => (total === 1 ? 'The operation failed.' : `${failed} of ${total} items failed.`),
} as const
