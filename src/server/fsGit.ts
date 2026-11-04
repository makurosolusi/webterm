// Dekorasi git untuk node files (WS-FM-08): `git status --porcelain=v2 -z` -> mark per path.
// execFile (argumen array, tanpa shell); hanya baca (GIT_OPTIONAL_LOCKS=0 supaya tak menyentuh index.lock).
import { execFile } from 'node:child_process'
import { ptyEnv } from './ptyShell'
import npath from 'node:path'
import { fsFail, type FsResult, type GitMark } from '../shared/fsContract'
import { failFrom } from './fsAtomic'
import { checkFsPath } from './fsOps'
import { createLogger } from './logs'

const log = createLogger('fs')

const GIT_TIMEOUT_MS = 5000
/** Batas record status yang diparse; selebihnya diabaikan (repo raksasa tak boleh membengkakkan respons). */
/** Batas keluaran git yang diterima (byte); lebih dari ini = galat bercontext, bukan memori tak terbatas. */
const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024
const GIT_MARKS_MAX = 5000
/** git: "bukan repo" / fatal umum. */
const GIT_FATAL_EXIT = 128
/** Kuat -> lemah; indeks kecil menang saat rollup folder. */
const MARK_PRIORITY: readonly GitMark[] = ['C', 'D', 'M', 'A', 'R', 'U']

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
    const kind = r[0]
    // Kolom sebelum path: `1` = 8, `2` = 9 (+ skor rename), `u` = 10.
    const fields = kind === '1' ? splitFields(r, 8) : kind === '2' ? splitFields(r, 9) : kind === 'u' ? splitFields(r, 10) : []
    if (kind === '2') i++ // path asal rename = token NUL berikutnya
    if (fields.length) res.push([fields[fields.length - 1], markOf(kind, fields[1])])
  }
  return res
}

function stronger(a: GitMark | undefined, b: GitMark): GitMark {
  return a && MARK_PRIORITY.indexOf(a) <= MARK_PRIORITY.indexOf(b) ? a : b
}

/** Mark git per path relatif ke `dir` (folder = mark terkuat anaknya). Bukan repo / tanpa git / timeout -> `{}`. */
export async function gitMarks(dirPath: string): Promise<FsResult<{ marks: Record<string, GitMark> }>> {
  const dir = checkFsPath(dirPath)
  if (typeof dir !== 'string') return dir
  const none = { ok: true as const, marks: {} }
  try {
    const [status, prefix] = await Promise.all([
      runGit(dir, ['status', '--porcelain=v2', '-z', '--untracked-files=normal', '--', '.']),
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
      for (let n = 1; n <= segs.length; n++) {
        const key = segs.slice(0, n).join('/')
        marks[key] = stronger(marks[key], m)
      }
    }
    return { ok: true, marks }
  } catch (err) {
    return failFrom('git status', dir, err)
  }
}
