// Global content search (Find in Files). Imitates Orca `src/shared/text-search.ts:46-77`
// (`buildRgArgs`: --no-config --json --hidden --glob !.git --max-filesize, fixed strings, ignore case)
// and `src/main/ripgrep/bundled-ripgrep-text-search.ts:136-148` (stop + kill rg the moment the cap is
// reached). Added for Rule 13: offset pagination (`--sort path` makes pages stable across re-runs) and
// cancellation by `searchId` (a newer request with the same id supersedes the old one, or
// `cancelGrep`). rg missing → the existing file listing (`searchFiles`) + an in-process line scan,
// flagged `engine: 'fallback'` so the UI can say so. Args are an array, never a shell (fsSearch.ts).
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fsErrCode, fsFail, type FsFail, type FsResult } from '../shared/fsContract'
import { checkFsPath } from './fsOps'
import { SEARCH_MATCH_ALL, searchFiles } from './fsSearch'

/** Matches per page when the caller sends no `limit`; the hard cap is GREP_PAGE_MAX. */
export const GREP_PAGE_DEFAULT = 100
export const GREP_PAGE_MAX = 500
/** Longest accepted query; rg itself has no need for more. */
export const GREP_QUERY_MAX = 1000
/** Preview text per match is clipped so one minified line cannot bloat the page. */
const PREVIEW_MAX = 240
/** Same ceiling as Orca `SEARCH_MAX_FILE_SIZE` order of magnitude: skip generated blobs. */
const MAX_FILE_MB = 5
const FALLBACK_FILE_MAX = MAX_FILE_MB * 1024 * 1024
/** A runaway search is killed after this long (Orca `SEARCH_TIMEOUT_MS`). */
const GREP_TIMEOUT_MS = 20_000

type Env = Record<string, string | undefined>
export interface GrepMatch { file: string; line: number; col: number; text: string }
export interface GrepPage {
  matches: GrepMatch[]
  /** Offset of the next page, `null` when this page reached the end. */
  nextOffset: number | null
  engine: 'rg' | 'fallback'
  cancelled: boolean
}
export interface GrepOpts { offset?: number; limit?: number; searchId?: string; env?: Env }

const running = new Map<string, () => void>()

/** Stop the in-flight search registered under `searchId`; true when there was one. */
export function cancelGrep(searchId: string): boolean {
  const stop = running.get(searchId)
  if (stop) stop()
  return stop !== undefined
}

const clip = (s: string): string => (s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s)
const intOr = (v: number | undefined, dflt: number, max: number): number =>
  v !== undefined && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : dflt

/** Collects one page out of a match stream: skips `offset`, keeps `limit`, says stop on the one after. */
function pager(offset: number, limit: number) {
  const matches: GrepMatch[] = []
  let seen = 0
  let more = false
  return {
    matches,
    /** false = page full and one more match exists: the caller stops the source. */
    push(m: GrepMatch): boolean {
      if (seen++ < offset) return true
      if (matches.length < limit) { matches.push(m); return true }
      more = true
      return false
    },
    next: () => (more ? offset + matches.length : null),
  }
}

/** `rg --json` match line → GrepMatch, or null for begin/end/summary messages. */
export function parseRgLine(line: string): GrepMatch | null {
  let msg: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: { start: number }[] } }
  try { msg = JSON.parse(line) } catch { return null }
  const d = msg.data
  if (msg.type !== 'match' || typeof d?.path?.text !== 'string') return null // byte-only names: not openable (Orca :105-110)
  const file = d.path.text.replace(/^\.\//, '')
  const text = (d.lines?.text ?? '').replace(/\r?\n$/, '')
  return { file, line: d.line_number ?? 0, col: (d.submatches?.[0]?.start ?? 0) + 1, text: clip(text) }
}

type Outcome = 'done' | 'missing' | 'cancelled'
/** One search's cancel state; `kill` is swapped in by whichever engine is running. */
interface Job { cancelled: boolean; kill: () => void }

function viaRg(root: string, q: string, page: ReturnType<typeof pager>, env: Env, job: Job): Promise<Outcome> {
  const args = ['--no-config', '--json', '--hidden', '--glob', '!.git', '--max-filesize', `${MAX_FILE_MB}M`,
    '--ignore-case', '--fixed-strings', '--sort', 'path', '--', q, '.']
  return new Promise((done) => {
    const proc = spawn('rg', args, { cwd: root, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'ignore'] })
    let rest = ''
    let outcome: Outcome = 'done'
    let missing = false
    const stop = (why: Outcome): void => { outcome = why; proc.kill() }
    job.kill = () => stop('cancelled')
    const timer = setTimeout(() => stop('cancelled'), GREP_TIMEOUT_MS) // reported as cancelled, not as the end
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      rest += chunk
      let at = rest.indexOf('\n')
      while (at >= 0 && outcome === 'done' && proc.exitCode === null) {
        const m = parseRgLine(rest.slice(0, at))
        rest = rest.slice(at + 1)
        if (m && !page.push(m)) { stop('done'); break }
        at = rest.indexOf('\n')
      }
    })
    proc.on('error', () => { missing = true }) // ENOENT: rg not on PATH
    proc.on('close', () => { clearTimeout(timer); done(job.cancelled ? 'cancelled' : missing ? 'missing' : outcome) })
  })
}

/** No rg: the existing listing (rg → git → walk, .gitignore honoured by git) + a plain line scan. */
async function viaFallback(root: string, q: string, page: ReturnType<typeof pager>, env: Env, job: Job): Promise<Outcome> {
  const listed = await searchFiles(root, SEARCH_MATCH_ALL, undefined, env)
  if (!listed.ok) return 'done'
  const needle = q.toLowerCase()
  // ponytail: sequential reads, fine for a fallback; rg is the fast path.
  for (const file of listed.files) {
    if (job.cancelled) return 'cancelled'
    let body: Buffer
    try { body = await readFile(resolve(root, file)) } catch { continue } // vanished mid-scan: skip
    if (body.length > FALLBACK_FILE_MAX || body.includes(0)) continue // binary or huge, as rg skips them
    const lines = body.toString('utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const col = lines[i].toLowerCase().indexOf(needle)
      if (col >= 0 && !page.push({ file, line: i + 1, col: col + 1, text: clip(lines[i]) })) return 'done'
    }
  }
  return 'done'
}

/** Same root policy as the file listing (`searchFiles`): fs path policy, then must be a directory. */
async function checkRoot(root: string): Promise<string | FsFail> {
  const checked = checkFsPath(root)
  if (typeof checked !== 'string') return checked
  try {
    if (!(await stat(checked)).isDirectory()) return fsFail('ENOTDIR', 'search root is not a directory')
    return checked
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? ''
    return fsFail(fsErrCode(code), `search root unavailable (${code || 'unknown'})`)
  }
}

/**
 * One page of content matches for `q` (literal, case-insensitive) under `root`, ordered by path then
 * line. `offset`/`limit` paginate (limit ≤ GREP_PAGE_MAX); `searchId` makes the search cancellable.
 */
export async function grepFiles(root: string, q: string, opts: GrepOpts = {}): Promise<FsResult<GrepPage>> {
  if (q.length > GREP_QUERY_MAX) return fsFail('EINVAL', 'query too long')
  const id = opts.searchId
  if (id) cancelGrep(id) // supersede: the previous keystroke's search is dead weight
  // Registered before any await, so a cancel that races root validation still lands.
  const job: Job = { cancelled: false, kill: () => {} }
  const cancel = (): void => { job.cancelled = true; job.kill() }
  if (id) running.set(id, cancel)
  const page = pager(intOr(opts.offset, 0, Number.MAX_SAFE_INTEGER), intOr(opts.limit, GREP_PAGE_DEFAULT, GREP_PAGE_MAX) || GREP_PAGE_DEFAULT)
  const env = opts.env ?? process.env
  try {
    const dir = await checkRoot(root)
    if (typeof dir !== 'string') return dir
    if (job.cancelled) return { ok: true, matches: [], nextOffset: null, engine: 'rg', cancelled: true }
    let engine: GrepPage['engine'] = 'rg'
    let outcome = await viaRg(dir, q, page, env, job)
    if (outcome === 'missing') { engine = 'fallback'; outcome = await viaFallback(dir, q, page, env, job) }
    const cancelled = outcome === 'cancelled'
    return { ok: true, matches: page.matches, nextOffset: cancelled ? null : page.next(), engine, cancelled }
  } catch (e) {
    return fsFail('EIO', `grep failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    if (id && running.get(id) === cancel) running.delete(id) // a newer search may own the id now
  }
}
