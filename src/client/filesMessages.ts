// Seluruh teks UI mutasi file manager (menu, dialog, toast) dan SATU peta kode galat -> kalimat.
// Komponen dan alur tidak boleh menulis kalimat sendiri; tambah/ubah di sini.
import type { FsErrCode, FsFail } from '../shared/fsContract'
import type { NameProblem } from './filesName'
import { isAuthFail } from './filesView'

/** Kata kerja mutasi untuk kalimat galat: "Gagal <aksi> “nama”". */
export type MutateAction = 'delete' | 'rename' | 'duplicate' | 'restore'
const ACTION_WORD: Record<MutateAction, string> = {
  delete: 'menghapus', rename: 'mengganti nama', duplicate: 'menduplikat', restore: 'memulihkan',
}

/** Alasan per kode galat (satu-satunya peta; `Record` penuh = kode baru di kontrak memaksa kalimat baru). */
const REASON: Record<FsErrCode, (name: string) => string> = {
  ENOENT: () => 'Item tidak ditemukan; mungkin sudah dipindah atau dihapus.',
  EEXIST: (n) => `Nama “${n}” sudah dipakai di folder ini.`,
  EACCES: () => 'Izin ditolak untuk akun yang menjalankan server.',
  EROFS: () => 'Lokasi ini hanya-baca (read-only).',
  EISDIR: () => 'Item ini adalah folder, bukan file.',
  ENOTDIR: () => 'Salah satu bagian path bukan folder.',
  EINVAL: () => 'Operasi tidak valid, misalnya memindahkan folder ke dalam dirinya sendiri atau nama tak sah.',
  ENAMETOOLONG: () => 'Nama terlalu panjang (maksimum 255 byte).',
  ENOSPC: () => 'Ruang disk penuh.',
  ENOTEMPTY: () => 'Folder tujuan tidak kosong.',
  EXDEV: () => 'Tidak bisa dipindah lintas volume.',
  EVERSION: () => 'Isi berubah sejak dibuka.',
  ETOOLARGE: () => 'Ukuran melewati batas.',
  EBINARY: () => 'Item ini berkas biner.',
  EDISABLED: () => 'Pengubahan file dimatikan di server ini.',
  EIO: () => 'Terjadi kesalahan saat mengakses disk atau jaringan.',
}
const REASON_AUTH = 'Sesi ditolak (401). Muat ulang halaman atau masuk lagi.'
/** Pemulihan ke tempat asal yang sudah terisi: EEXIST bermakna lain daripada saat rename. */
const REASON_RESTORE_EXISTS = 'Tempat asalnya sudah terisi item lain, jadi tidak ditimpa.'

/** Alasan satu `FsFail` dalam bahasa jelas; 401 (terselubung sebagai EIO oleh fsClient) dikenali. */
export function failReason(fail: Pick<FsFail, 'code' | 'error'>, name: string, action?: MutateAction): string {
  if (isAuthFail(fail)) return REASON_AUTH
  if (action === 'restore' && fail.code === 'EEXIST') return REASON_RESTORE_EXISTS
  return REASON[fail.code](name)
}

/** Kalimat lengkap satu kegagalan: "Gagal menghapus “a”. <alasan>". */
export function failText(action: MutateAction, name: string, fail: Pick<FsFail, 'code' | 'error'>, subject = name): string {
  // `subject` = nama yang dirujuk alasan (rename EEXIST menyebut nama TUJUAN, bukan nama sumber).
  return `Gagal ${ACTION_WORD[action]} “${name}”. ${failReason(fail, subject, action)}`
}

const PROBLEM: Record<NameProblem, string> = {
  empty: 'Nama tidak boleh kosong.',
  reserved: 'Nama “.” dan “..” tidak boleh dipakai.',
  slash: 'Nama tidak boleh memuat garis miring (/ atau \\).',
  nul: 'Nama memuat karakter terlarang.',
  long: 'Nama terlalu panjang (maksimum 255 byte).',
}
/** Pesan validasi nama untuk input rename. */
export const nameProblemText = (p: NameProblem): string => PROBLEM[p]

const items = (n: number, first: string): string => (n === 1 ? `“${first}”` : `${n} item`)

export const MENU = {
  rename: 'Rename…', duplicate: 'Duplicate', trash: 'Delete', permanent: 'Delete Permanently…',
} as const
export const KEYS = { rename: 'F2', trash: 'Delete', permanent: '⇧Delete' } as const

export const CONFIRM = {
  cancel: 'Batal',
  trashTitle: (n: number, first: string) => `Pindahkan ${items(n, first)} ke Trash?`,
  trashBody: 'Item bisa dipulihkan lewat Undo beberapa detik setelahnya.',
  trashOk: 'Pindahkan ke Trash',
  permTitle: (n: number, first: string) => `Hapus permanen ${items(n, first)}?`,
  permBody: 'Tindakan ini tidak bisa dibatalkan.',
  permOk: 'Hapus permanen',
} as const

export const TOAST = {
  undo: 'Undo',
  trashed: (n: number, first: string) => `${items(n, first)} dipindahkan ke Trash.`,
  deleted: (n: number, first: string) => `${items(n, first)} dihapus permanen.`,
  duplicated: (n: number, first: string) => `${items(n, first)} diduplikat.`,
  restored: (n: number, first: string) => `${items(n, first)} dipulihkan.`,
  failedSome: (failed: number, total: number) => (total === 1 ? 'Operasi gagal.' : `${failed} dari ${total} item gagal diproses.`),
} as const
