// Quick Open server (WS-FM-09): daftar file relatif `root`, urutan sumber rg -> git -> penelusuran fs.
// Proses di-spawn dengan ARGUMEN ARRAY (tanpa shell); `q` hanya dipakai sebagai filter in-process,
// tidak pernah menjadi argumen proses. Path/isi tidak di-log (Rule 12). Memakai node:child_process,
// bukan Bun.spawn/Bun.Glob: tsc proyek tidak punya tipe Bun (lihat nameGen.ts), dan hasilnya sama.
import { spawn } from 'node:child_process'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fsErrCode, fsFail, type FsResult } from '../shared/fsContract'
import { checkFsPath } from './fsOps'

/** Batas hasil per request; di atasnya `truncated: true` (Rule 13). */
export const SEARCH_MAX_RESULTS = 50_000
/** `q` ini = tanpa filter (dispatcher mewajibkan `q` non-kosong; klien meminta daftar penuh sekali lalu mencocokkan lokal). */
export const SEARCH_MATCH_ALL = '*'
/** Jumlah `lstat` paralel saat memeriksa symlink keluar root (cegah EMFILE). */
const LSTAT_BATCH = 128
/** Direktori yang dilewati penelusuran fallback (tanpa .gitignore). */
const WALK_SKIP = new Set(['.git', 'node_modules'])

type Env = Record<string, string | undefined>
/** Sumber daftar file: `null` = perintah tak tersedia / bukan repo, lanjut ke sumber berikutnya. */
type Source = (root: string, accept: (rel: string) => boolean, env: Env) => Promise<boolean | null>

/** Subsequence: semua huruf `q` muncul berurutan di `s` (pemanggil sudah menurunkan huruf besar). */
function isSubsequence(q: string, s: string): boolean {
  let i = 0
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++
  return i === q.length
}

/** Path relatif aman: bukan absolut dan tanpa segmen `..`. */
function isInside(rel: string): boolean {
  return rel !== '' && !isAbsolute(rel) && !rel.split(/[\\/]/).includes('..')
}

/** Jalankan perintah dan alirkan keluaran NUL-terpisah ke `accept` (false = berhenti & bunuh proses). `null` bila tak bisa dipakai. */
function spawnLines(cmd: string[], cwd: string, env: Env, accept: (rel: string) => boolean): Promise<boolean | null> {
  return new Promise((done) => {
    const proc = spawn(cmd[0], cmd.slice(1), { cwd, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'ignore'] })
    let rest = ''
    let seen = 0
    let stopped = false
    let failed = false
    proc.stdout.setEncoding('utf8')
    const feed = (chunk: string): void => {
      rest += chunk
      let at = rest.indexOf('\0')
      while (!stopped && at >= 0) {
        const rel = rest.slice(0, at)
        rest = rest.slice(at + 1)
        if (rel) { seen++; if (!accept(rel)) stopped = true }
        at = rest.indexOf('\0')
      }
      if (stopped) proc.kill()
    }
    proc.stdout.on('data', feed)
    // ENOENT (biner tak ada di PATH): sumber ini dilewati, bukan galat.
    proc.on('error', () => { failed = true; done(null) })
    proc.on('close', (code) => {
      if (failed) return
      if (!stopped) feed('\0')
      // rg: 1 = tidak ada file (sah). Kode lain tanpa keluaran sama sekali = sumber tak bisa dipakai.
      done(code === 0 || code === 1 || seen > 0 || stopped ? true : null)
    })
  })
}

const viaRg: Source = (root, accept, env) =>
  spawnLines(['rg', '--files', '--hidden', '--null', '--glob', '!.git'], root, env, accept)

const viaGit: Source = (root, accept, env) =>
  spawnLines(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], root, env, accept)

/** Telusuri `dir` (relatif `root`) tanpa mengikuti symlink; false = `accept` meminta berhenti. */
async function walk(root: string, dir: string, accept: (rel: string) => boolean): Promise<boolean> {
  for (const d of await readdir(resolve(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${d.name}` : d.name
    if (d.isDirectory()) {
      if (!WALK_SKIP.has(d.name) && !(await walk(root, rel, accept))) return false
    } else if (!accept(rel)) return false
  }
  return true
}

// ponytail: tidak membaca .gitignore; hanya .git/node_modules dilewati. Naikkan ke parser ignore bila rg dan git sama-sama tak ada di produksi.
const viaWalk: Source = async (root, accept) => { await walk(root, '', accept); return true }

/** Buang symlink yang menunjuk keluar `realRoot` (atau putus); file biasa tidak di-realpath. */
async function dropEscapingLinks(realRoot: string, root: string, files: string[]): Promise<string[]> {
  const keep: boolean[] = []
  for (let i = 0; i < files.length; i += LSTAT_BATCH) {
    keep.push(...await Promise.all(files.slice(i, i + LSTAT_BATCH).map(async (rel) => {
      const abs = resolve(root, rel)
      try {
        if (!(await lstat(abs)).isSymbolicLink()) return true
        const target = relative(realRoot, await realpath(abs))
        return isInside(target.split(sep).join('/'))
      } catch {
        return false // hilang saat dipindai / link putus: tidak ditawarkan
      }
    })))
  }
  return files.filter((_, i) => keep[i])
}

/**
 * Daftar file di `root` (relatif, urut abjad) yang cocok `q` (subsequence, `*` = semua), maksimal `limit`
 * (<= SEARCH_MAX_RESULTS). Hormati .gitignore lewat rg/git; `env` hanya untuk tes (PATH tersamar).
 */
export async function searchFiles(
  root: string, q: string, limit?: number, env: Env = process.env,
): Promise<FsResult<{ files: string[]; truncated: boolean }>> {
  const checked = checkFsPath(root)
  if (typeof checked !== 'string') return checked
  let realRoot: string
  try {
    if (!(await stat(checked)).isDirectory()) return fsFail('ENOTDIR', 'search root is not a directory')
    realRoot = await realpath(checked)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? ''
    return fsFail(fsErrCode(code), `search root unavailable (${code || 'unknown'})`)
  }

  const cap = limit !== undefined && Number.isInteger(limit) && limit > 0 ? Math.min(limit, SEARCH_MAX_RESULTS) : SEARCH_MAX_RESULTS
  const needle = q.toLowerCase()
  const all = q === SEARCH_MATCH_ALL
  const files: string[] = []
  let truncated = false
  const accept = (rel: string): boolean => {
    if (!isInside(rel) || (!all && !isSubsequence(needle, rel.toLowerCase()))) return true
    if (files.length >= cap) { truncated = true; return false }
    files.push(rel)
    return true
  }

  for (const source of [viaRg, viaGit, viaWalk]) {
    files.length = 0
    truncated = false
    try {
      if (await source(checked, accept, env) !== null) break
    } catch (e) {
      return fsFail('EIO', `search failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const safe = await dropEscapingLinks(realRoot, checked, files)
  return { ok: true, files: safe.sort(), truncated }
}
