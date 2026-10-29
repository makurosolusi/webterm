// Kontrak wire untuk kesadaran git sebuah cwd: dipakai server (`src/server/gitInfo.ts`) DAN
// client, jadi dua sisi batas HTTP memakai satu tipe, bukan dua tebakan bentuk JSON.
//
// Tidak ada `node:*` di sini, sengaja — file ini masuk graph bundle client.

/** Path yang diminta, bagaimana ia dibaca sebagai repo. */
export type GitPathState =
  /** Path ada dan di dalam worktree sebuah repo git. `repo` terisi. */
  | 'repo'
  /** Path ada tapi tidak di dalam repo git mana pun. Normal, bukan kegagalan. */
  | 'not-a-repo'
  /** Path tidak ada (cwd dihapus/di-unmount setelah node dibuat). */
  | 'missing'
  /** git tidak bisa menjawab: timeout, repo bare, atau kegagalan tak terduga. Berbeda dari
   *  `not-a-repo` dengan sengaja — "tidak tahu" bukan "bukan repo". */
  | 'error'

/** Keadaan satu repo. Satu objek per repo yang dijawab, disalin ke tiap path yang ada di dalamnya
 *  supaya client tidak perlu join apa pun. */
export interface GitRepoInfo {
  /** Root worktree, absolut dan sudah di-realpath oleh git (`rev-parse --show-toplevel`). */
  root: string
  /** Nama branch, atau `null` saat HEAD detached. */
  branch: string | null
  /** Short oid HEAD (7 char), atau `''` di repo yang belum punya commit sama sekali. */
  head: string
  /** Ada perubahan apa pun di worktree: staged, modified, unmerged, ATAU untracked. File yang
   *  di-gitignore tidak dihitung. */
  dirty: boolean
  /** Nama ref upstream (mis. `origin/main`), atau `null` bila branch ini tidak punya upstream. */
  upstream: string | null
  /** Commit di depan upstream; `0` bila tidak ada upstream. */
  ahead: number
  /** Commit di belakang upstream, selalu non-negatif; `0` bila tidak ada upstream. */
  behind: number
}

/** Satu jawaban untuk satu path yang diminta. */
export interface GitPathInfo {
  /** Path PERSIS seperti yang diminta client (belum di-resolve), supaya bisa dipakai jadi key. */
  path: string
  state: GitPathState
  /** Non-null tepat ketika `state === 'repo'`. */
  repo: GitRepoInfo | null
}

/** Body respons `POST /api/git/info`. Satu entry per path yang diminta, urutan dan panjangnya
 *  sama dengan `paths` di request — termasuk duplikat, jadi client boleh zip per indeks. */
export interface GitInfoResponse {
  results: GitPathInfo[]
}

/** Endpoint-nya, dibagi supaya client tidak menuliskan ulang stringnya. */
export const GIT_INFO_PATH = '/api/git/info'

/**
 * Batas jumlah path per request. Tiap path yang unik berarti satu proses git, jadi tanpa batas
 * sebuah request bisa men-spawn ribuan proses sekaligus. 64 jauh di atas jumlah node yang masuk
 * akal di satu canvas; client yang butuh lebih memecah requestnya sendiri.
 */
export const GIT_INFO_MAX_PATHS = 64
