// Dekorasi git untuk node files (WS-FM-08): `git status --porcelain=v2 -z --branch --ignored=matching`
// -> mark per path + branch/ahead/behind (footer). `resolveGitDir` feeds the gitdir watch in fsWatch.ts.
// execFile (argumen array, tanpa shell); hanya baca (GIT_OPTIONAL_LOCKS=0 supaya tak menyentuh index.lock).
import { execFile } from 'node:child_process'
import { ptyEnv } from './ptyShell'
import npath from 'node:path'
import { fsFail, type FsResult, type GitBranch, type GitMark, type GitStatus } from '../shared/fsContract'
import { failFrom } from './fsAtomic'
import { checkFsPath } from './fsOps'
import { createLogger } from './logs'

const log = createLogger('fs')

const GIT_TIMEOUT_MS = 5000
/** Batas keluaran git yang diterima (byte); lebih dari ini = galat bercontext, bukan memori tak terbatas. */
const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024
/** Batas record status yang diparse (ignored ikut dihitung; git mencetaknya terakhir, jadi yang terpotong duluan). */
const GIT_MARKS_MAX = 5000
/** Detached HEAD label length: VS Code `headLabel` shows the first 8 chars of the commit. */
const DETACHED_OID_LEN = 8
/** git: "bukan repo" / fatal umum. */
const GIT_FATAL_EXIT = 128
/** Kuat -> lemah; indeks kecil menang saat rollup folder. */
const MARK_PRIORITY: readonly GitMark[] = ['C', 'D', 'M', 'A', 'R', 'U', 'I']

type GitRun = { out: string; code: number } | 'missing' | 'timeout'

/** Jalankan git tanpa shell (argumen array). `execFile` = ENOENT/timeout/kode keluar dibedakan jelas. */
function runGit(dir: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BYTES, env: { ...ptyEnv(process.env, { interactive: false }), GIT_OPTIONAL_LOCKS: '0' } }, (err, out) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null
      if (!e) return resolve({ out, code: 0 })
      if (e.code === 'ENOENT') return resolve('missing')
      if (e.killed) return resolve('timeout')
      if (typeof e.code === 'number') return resolve({ out, code: e.code })
      reject(e)
    })
  })
}

/** Mark satu record `1`/`2`/`u` dari kolom XY. */
function markOf(kind: string, xy: string): GitMark {
  if (kind === 'u') return 'C'
  if (kind === '2') return 'R'
  if (xy.includes('D')) return 'D'
  if (xy.includes('A')) return 'A'
  return 'M'
}

/** Ambil `n` kolom pertama (dipisah spasi) dari `rec`; sisanya = path (boleh berspasi). */
function splitFields(rec: string, n: number): string[] {
  const f: string[] = []
  let at = 0
  for (let i = 0; i < n; i++) {
    const sp = rec.indexOf(' ', at)
    if (sp < 0) return []
    f.push(rec.slice(at, sp))
    at = sp + 1
  }
  f.push(rec.slice(at))
  return f
}

/** Parse keluaran porcelain v2 -z menjadi pasangan [path-relatif-repo, mark]. */
export function parseStatus(out: string): Array<[string, GitMark]> {
  const rec = out.split('\0')
  const res: Array<[string, GitMark]> = []
  for (let i = 0; i < rec.length && res.length < GIT_MARKS_MAX; i++) {
    const r = rec[i]
    if (r.startsWith('? ')) { res.push([r.slice(2), 'U']); continue }
    if (r.startsWith('! ')) { res.push([r.slice(2), 'I']); continue }
    const kind = r[0]
    // Kolom sebelum path: `1` = 8, `2` = 9 (+ skor rename), `u` = 10.
    const fields = kind === '1' ? splitFields(r, 8) : kind === '2' ? splitFields(r, 9) : kind === 'u' ? splitFields(r, 10) : []
    if (kind === '2') i++ // path asal rename = token NUL berikutnya
    if (fields.length) res.push([fields[fields.length - 1], markOf(kind, fields[1])])
  }
  return res
}

/** Branch headers (`# branch.*`) of porcelain v2 -z; null when absent (not a repo / no `--branch`). */
export function parseBranch(out: string): GitBranch | null {
  let info: GitBranch | null = null
  for (const r of out.split('\0')) {
    if (!r.startsWith('# branch.')) continue
    info ??= { branch: null, head: '', upstream: null, ahead: 0, behind: 0 }
    const [, key, v = '', w = ''] = r.split(' ')
    if (key === 'branch.oid') info.head = v === '(initial)' ? '' : v.slice(0, DETACHED_OID_LEN)
    else if (key === 'branch.head') info.branch = v === '(detached)' ? null : v
    else if (key === 'branch.upstream') info.upstream = v
    // `+2 -0`: abs() also turns `-0` into 0.
    else if (key === 'branch.ab') { info.ahead = Math.abs(Number(v)) || 0; info.behind = Math.abs(Number(w)) || 0 }
  }
  return info
}

function stronger(a: GitMark | undefined, b: GitMark): GitMark {
  return a && MARK_PRIORITY.indexOf(a) <= MARK_PRIORITY.indexOf(b) ? a : b
}

/** `gitDir`: per-worktree gitdir (linked worktree -> `.git/worktrees/<name>`); `commonDir`: shared `.git` (refs, packed-refs). */
export interface GitDirs { gitDir: string; commonDir: string }

/** Absolute gitdir + common dir of the repo containing `dir`; null when none. */
export async function resolveGitDir(dir: string): Promise<GitDirs | null> {
  const r = await runGit(dir, ['rev-parse', '--absolute-git-dir', '--git-common-dir'])
  if (typeof r !== 'object' || r.code !== 0) return null
  const [gitDir, common] = r.out.split('\n')
  // `--git-common-dir` may print a path relative to the cwd (`.git`), so resolve it against `dir`.
  return gitDir && common ? { gitDir, commonDir: npath.resolve(dir, common) } : null
}

/** Mark git per path relatif ke `dir` (folder = mark terkuat anaknya; ignored tak di-rollup) + branch.
 *  Bukan repo / tanpa git / timeout -> `{ marks: {} }` tanpa `branch`. */
export async function gitMarks(dirPath: string): Promise<FsResult<GitStatus>> {
  const dir = checkFsPath(dirPath)
  if (typeof dir !== 'string') return dir
  const none = { ok: true as const, marks: {} }
  try {
    const [status, prefix] = await Promise.all([
      runGit(dir, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal', '--ignored=matching', '--', '.']),
      runGit(dir, ['rev-parse', '--show-prefix']),
    ])
    if (status === 'missing' || prefix === 'missing') return none
    if (status === 'timeout' || prefix === 'timeout') {
      log.warn('fs.git', 'git status timed out', { file: npath.basename(dir) })
      return none
    }
    if (status.code === GIT_FATAL_EXIT || prefix.code === GIT_FATAL_EXIT) return none
    if (status.code !== 0 || prefix.code !== 0) return fsFail('EIO', `git status failed: ${npath.basename(dir)} (exit ${status.code || prefix.code})`)
    // Git melaporkan path relatif ke ROOT repo; buang prefix `dir` supaya relatif ke `dir`.
    const root = prefix.out.replace(/\n$/, '')
    const marks: Record<string, GitMark> = {}
    for (const [p, m] of parseStatus(status.out)) {
      if (!p.startsWith(root)) continue
      const segs = p.slice(root.length).split('/').filter(Boolean)
      // VS Code: ignored is a leaf-only colour, never bubbled to the parent folder.
      for (let n = m === 'I' ? segs.length : 1; n <= segs.length; n++) {
        const key = segs.slice(0, n).join('/')
        marks[key] = stronger(marks[key], m)
      }
    }
    const branch = parseBranch(status.out)
    return branch ? { ok: true, marks, branch } : { ok: true, marks }
  } catch (err) {
    return failFrom('git status', dir, err)
  }
}
