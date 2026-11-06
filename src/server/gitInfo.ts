// Kesadaran git untuk cwd node: untuk sekumpulan path, repo mana (kalau ada), branch apa, kotor
// atau tidak, dan berapa ahead/behind terhadap upstream. Permukaan baru — tidak ada padanannya di
// webterm sebelum ini (satu-satunya `git` yang sudah ada adalah `check-ignore` di `fsOps.ts`).
//
// Service DAN route tinggal di satu file, berbeda dari pasangan `fsOps.ts`/`fsApi.ts`: di sana
// pemisahan membayar enam verb dengan dua kontrak error yang berbeda; di sini ada satu verb dengan
// satu kontrak, dan dua file cuma menambah satu import.
//
// SATU PANGGILAN GIT PER REPO, BUKAN TIGA. `status --porcelain=v2 --branch` memulangkan oid, nama
// branch, upstream, ahead/behind DAN daftar perubahan dalam satu keluaran, jadi `rev-parse HEAD` +
// `rev-list --count` terpisah tidak diperlukan. Format headernya diverifikasi pada git 2.39:
//
//   # branch.oid <oid>|(initial)      # branch.head <nama>|(detached)
//   # branch.upstream <ref>           # branch.ab +<ahead> -<behind>
//
// Dua header terakhir HANYA muncul bila branch punya upstream. Baris non-header adalah perubahan
// (`1 `/`2 `/`u `/`? `); nama ref tidak boleh memuat spasi, jadi split per spasi aman.
//
// Yang TETAP butuh satu panggilan per path adalah `rev-parse --show-toplevel`, karena root repo
// adalah justru kunci yang dipakai untuk mengelompokkan path — tapi itu panggilan murah yang tidak
// menyentuh worktree, sementara `status` yang mahal berjalan sekali per repo. Untuk N path di M
// repo: N murah + M mahal, bukan 3N.
//
// HANYA BACA. `rev-parse` dan `status` adalah satu-satunya subcommand di file ini, dan
// `--no-optional-locks` menahan `status` dari me-refresh index di `.git` — jadi endpoint ini tidak
// bisa mengubah repo siapa pun bahkan secara tidak langsung.
//
// Path dari client dijalankan lewat argv array (`execFile`, bukan shell string), jadi tidak ada
// permukaan injeksi: nilainya sampai ke `git` sebagai satu argumen apa pun isinya. Validasi
// path-nya sendiri sama persis dengan yang sudah berlaku di `/api/fs/*` — `resolveFsPath` dari
// `fsOps.ts`, yang expand `~` lalu `path.resolve`. Sengaja TIDAK ada jail; alasan lengkapnya ada di
// kepala `fsOps.ts` (yang menjaga permukaan ini adalah bind loopback + Origin + token di
// `src/server/auth.ts`, bukan pemagaran path).
import { execFile } from 'node:child_process'
import { gitCommand } from './gitExec'
import { promises as fs } from 'node:fs'
import { promisify } from 'node:util'
import {
  GIT_INFO_MAX_PATHS,
  GIT_INFO_PATH,
  type GitInfoResponse,
  type GitPathInfo,
  type GitPathState,
  type GitRepoInfo,
} from '../shared/gitInfo'
import { resolveFsPath } from './fsOps'
import { createLogger } from './logs'

const log = createLogger('git')

const run = promisify(execFile)

/**
 * Batas satu panggilan git. Yang dijaga bukan repo yang lambat tapi repo yang TIDAK AKAN pernah
 * menjawab: cwd di mount jaringan yang mati membuat `stat`/`status` menggantung tanpa batas, dan
 * tanpa timeout satu node seperti itu menahan request sampai client timeout sendiri. 5 s di atas
 * `status` dingin pada repo lokal besar, dan masih di bawah ambang sabar untuk sebuah badge.
 * ponytail: ambang tetap; jadikan setting kalau ada repo nyata yang sah-sah saja menembusnya.
 */
const GIT_TIMEOUT_MS = 5_000

/** Sama dengan `flagIgnored` di fsOps. Worktree yang sangat kotor bisa melewatinya; lihat
 *  `repoStatus` untuk kenapa keluaran terpotong masih dijawab, bukan dibuang. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024

/** Panjang short oid yang ditampilkan — yang dipakai git sendiri untuk `--short` secara default. */
const SHORT_OID_LEN = 7

const BRANCH_OID = '# branch.oid'

/** Hasil satu panggilan git. `stdout` tetap dibawa saat gagal: `status` yang melewati maxBuffer
 *  tetap sudah mencetak headernya, dan itu cukup untuk menjawab. */
interface GitRun {
  ok: boolean
  stdout: string
  /** Proses dibunuh karena batas (timeout atau maxBuffer), bukan keluar sendiri dengan exit code. */
  killed: boolean
}

async function git(cwd: string, args: string[]): Promise<GitRun> {
  try {
    // gitExec.ts: filtered env, no prompt, repo-local fsmonitor/hooks/diff drivers off.
    const g = gitCommand(['--no-optional-locks', '-C', cwd, ...args])
    const { stdout } = await run(g.file, g.args, { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: g.env })
    return { ok: true, stdout, killed: false }
  } catch (err) {
    const e = err as { stdout?: string; killed?: boolean }
    return { ok: false, stdout: e.stdout ?? '', killed: e.killed === true }
  }
}

/** Baca keluaran `status --porcelain=v2 --branch` menjadi satu `GitRepoInfo`. */
function parseStatus(root: string, out: string): GitRepoInfo {
  const info: GitRepoInfo = { root, branch: null, head: '', dirty: false, upstream: null, ahead: 0, behind: 0 }
  for (const line of out.split('\n')) {
    if (line === '') continue
    // Baris apa pun yang bukan header adalah sebuah perubahan — staged, modified, unmerged, atau
    // untracked. Tanpa `--ignored` file yang di-gitignore tidak ikut tercetak.
    if (!line.startsWith('# ')) {
      info.dirty = true
      continue
    }
    const f = line.split(' ')
    const value = f[2]
    if (!value) continue
    if (f[1] === 'branch.oid') info.head = value === '(initial)' ? '' : value.slice(0, SHORT_OID_LEN)
    else if (f[1] === 'branch.head') info.branch = value === '(detached)' ? null : value
    else if (f[1] === 'branch.upstream') info.upstream = value
    else if (f[1] === 'branch.ab') {
      // `+2 -0`: behind dicetak bertanda minus, dan `Math.abs` juga menormalkan `-0` jadi `0`.
      info.ahead = Math.abs(Number(value)) || 0
      info.behind = Math.abs(Number(f[3])) || 0
    }
  }
  return info
}

/** Keadaan satu repo, atau `null` bila git tidak bisa menjawab. SEKALI per root. */
async function repoStatus(root: string): Promise<GitRepoInfo | null> {
  const r = await git(root, ['status', '--porcelain=v2', '--branch'])
  // Keluaran dipakai juga saat `!ok`: worktree dengan puluhan ribu file untracked melewati
  // maxBuffer, tapi header selalu dicetak lebih dulu — jadi branch/upstream/ahead tetap terbaca
  // dan potongan yang ada sudah membuktikan `dirty`. Yang benar-benar gagal adalah keluaran yang
  // bahkan tidak punya header.
  if (!r.stdout.includes(BRANCH_OID)) {
    // Path TIDAK di-log: path absolut pengguna memuat namanya (Rule 12). Yang perlu untuk
    // diagnosis adalah apakah ini batas waktu atau git yang menolak.
    log.warn('git.status.unusable', 'git status unusable', { timedOut: r.killed })
    return null
  }
  return parseStatus(root, r.stdout)
}

/** Satu path: ada/tidak, di repo mana, lalu keadaan repo itu (di-memo per root). */
async function inspect(
  requested: string,
  statuses: Map<string, Promise<GitRepoInfo | null>>
): Promise<{ state: GitPathState; repo: GitRepoInfo | null }> {
  const target = resolveFsPath(requested)
  // Keberadaan dibaca dari `stat`, bukan dari stderr git: git membedakan "tidak ada" dari "bukan
  // repo" hanya di teks pesannya, dan teks itu bergantung locale. `stat` tidak.
  const exists = await fs.stat(target).then(() => true, () => false)
  if (!exists) return { state: 'missing', repo: null }

  const top = await git(target, ['rev-parse', '--show-toplevel'])
  // Exit non-nol tanpa dibunuh = bukan repo (git keluar 128). Dibunuh = kita tidak tahu.
  if (!top.ok) return { state: top.killed ? 'error' : 'not-a-repo', repo: null }
  const root = top.stdout.trim()
  // Keluaran kosong meski exit 0: repo bare, yang tidak punya worktree untuk ditanyai.
  if (!root) return { state: 'error', repo: null }

  let pending = statuses.get(root)
  if (!pending) {
    pending = repoStatus(root)
    // `set` sinkron tepat setelah `get`, tanpa await di antaranya: dua path di repo yang sama
    // karena itu tidak bisa saling menyelip dan memanggil `status` dua kali.
    statuses.set(root, pending)
  }
  const repo = await pending
  return repo ? { state: 'repo', repo } : { state: 'error', repo: null }
}

/**
 * Keadaan git untuk tiap path yang diminta. Satu proses git per path UNIK untuk menemukan root,
 * dan satu `status` per REPO — jadi dua belas node di satu repo berarti satu `status`, bukan dua
 * belas, dan dua node dengan cwd yang sama tidak men-spawn apa pun dua kali.
 */
export async function collectGitInfo(paths: string[]): Promise<GitPathInfo[]> {
  const statuses = new Map<string, Promise<GitRepoInfo | null>>()
  const byPath = new Map<string, GitPathInfo>()
  await Promise.all(
    [...new Set(paths)].map(async (p) => {
      byPath.set(p, { path: p, ...(await inspect(p, statuses)) })
    })
  )
  // Urutan dan panjang mengikuti request apa adanya, duplikat ikut terjawab: client boleh
  // memasangkannya per indeks maupun per `path`.
  return paths.map((p) => byPath.get(p) as GitPathInfo)
}

/** Status + body JSON untuk dijawab pemanggil, atau `null` bila path/method bukan milik modul ini
 *  (dan 404 terakhir di `api.ts` yang menjawab, sama seperti `workspacesRoute`). */
export type GitApiResult = { status: number; body: unknown } | null

/**
 * `POST /api/git/info` dengan body `{ paths: string[] }`.
 *
 * POST, bukan GET, karena permintaannya adalah DAFTAR path absolut: selusin di query string
 * menabrak batas panjang URL di proxy, dan path adalah justru hal yang paling tidak ingin kita
 * tulis ke access log. Ini tetap operasi baca — tidak ada state server yang berubah.
 */
export async function gitInfoRoute(
  path: string,
  method: string,
  body: () => Promise<string>
): Promise<GitApiResult> {
  if (path !== GIT_INFO_PATH || method !== 'POST') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(await body())
  } catch {
    return { status: 400, body: { error: 'bad json' } }
  }
  // `null`, angka, string, dan array semuanya JSON yang sah — jadi bentuknya diperiksa, bukan
  // cuma hasil parse-nya.
  const raw =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { paths?: unknown }).paths
      : undefined
  if (!Array.isArray(raw)) return { status: 400, body: { error: 'paths must be an array' } }
  if (raw.length > GIT_INFO_MAX_PATHS) {
    return { status: 400, body: { error: `at most ${GIT_INFO_MAX_PATHS} paths` } }
  }
  // Entry yang bukan string non-kosong ditolak, tidak disaring: sebuah jawaban yang entry-nya
  // lebih sedikit daripada yang diminta akan membuat client salah memasangkan per indeks.
  if (!raw.every((p) => typeof p === 'string' && p.trim() !== '')) {
    return { status: 400, body: { error: 'paths must be non-empty strings' } }
  }
  const res: GitInfoResponse = { results: await collectGitInfo(raw as string[]) }
  return { status: 200, body: res }
}
