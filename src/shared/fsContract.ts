// Kontrak lintas-WS file manager (PLAN/FILEMANAGER-b.md §5). READ-ONLY setelah W0a: perubahan di
// sini = eskalasi ke orkestrator, karena server (fsApi/fsOps*), klien (fsClient/filesSlots) dan
// WebSocket (protocol.ts) semuanya bergantung pada bentuk ini. Hanya tipe, satu tabel status, dan dua helper murni.

export type FsErrCode = 'ENOENT'|'EEXIST'|'EACCES'|'EISDIR'|'ENOTDIR'|'EINVAL'|'ENAMETOOLONG'
  |'ENOSPC'|'EROFS'|'ENOTEMPTY'|'EXDEV'|'EVERSION'|'ETOOLARGE'|'EBINARY'|'EDISABLED'|'EIO'
/** Opaque: `${mtimeNs}-${size}`. Klien TIDAK mem-parse, hanya membawanya balik sebagai `expectedVersion`. */
export type FsVersion = string
export interface FsFail { ok: false; code: FsErrCode; error: string; current?: FsVersion }
export interface FsOk { ok: true; version?: FsVersion }
export type FsResult<T = object> = (FsOk & T) | FsFail

/** Status HTTP per kode galat (§5.3). Satu tabel dipakai dispatcher server dan tes. */
export const FS_ERR_STATUS: Record<FsErrCode, number> = {
  EEXIST: 409, EVERSION: 409, ENOTEMPTY: 409,
  ENOENT: 404,
  EACCES: 403, EROFS: 403,
  EISDIR: 400, ENOTDIR: 400, EINVAL: 400, ENAMETOOLONG: 400, EXDEV: 400,
  ETOOLARGE: 413,
  EBINARY: 415,
  ENOSPC: 507,
  EDISABLED: 501,
  EIO: 500,
}

/** Bangun `FsFail`; `current` hanya ikut bila ada (EVERSION). */
export function fsFail(code: FsErrCode, error: string, current?: FsVersion): FsFail {
  return current === undefined ? { ok: false, code, error } : { ok: false, code, error, current }
}

/** errno Node -> `FsErrCode`; yang tak dikenal = EIO (menebak lebih buruk daripada mengaku tak tahu). */
export function fsErrCode(errno: string): FsErrCode {
  return Object.hasOwn(FS_ERR_STATUS, errno) ? (errno as FsErrCode) : 'EIO'
}

export type EntryKind = 'file'|'dir'|'symlink-file'|'symlink-dir'|'symlink-broken'|'other'
/** C = conflict (badge `!`), I = ignored (no rollup); rollup folder = mark terkuat anak. */
export type GitMark = 'M'|'A'|'D'|'U'|'R'|'C'|'I'
/** Branch state from `status --branch` headers. `branch` null = detached (`head` = short oid). */
export interface GitBranch { branch: string | null; head: string; upstream: string | null; ahead: number; behind: number }
/** `git-status` response body; `branch` is absent when the dir is not inside a repo. */
export interface GitStatus { marks: Record<string, GitMark>; branch?: GitBranch }
/** Superset `DirEntry` lama `{name,dir,ignored}`. */
export interface FileMeta {
  name: string
  /** Hasil resolve target (symlink ke dir = true). */
  dir: boolean
  ignored: boolean
  kind?: EntryKind
  size?: number
  mtimeMs?: number
  git?: GitMark
}
export interface ListV2 { entries: FileMeta[]; truncated: boolean }
export type ReadEncoding = 'utf8' | 'non-utf8' | 'binary'
export interface ReadMeta { content: string; version: FsVersion; encoding: ReadEncoding }
export interface FsCapabilities {
  mutate: boolean
  viewers: boolean
  watch: boolean
  git: boolean
  quickOpen: boolean
  upload: boolean
  listMax: number
}

// WebSocket (protocol.ts): client->server {t:'fswatch',dir} | {t:'fsunwatch',dir}; server->client {t:'fsdirty',dir}
export type FsEventKind = 'created'|'deleted'|'renamed'|'written'|'dirty'
export interface FsEvent { kind: FsEventKind; path: string; from?: string; origin: 'local'|'remote' }
