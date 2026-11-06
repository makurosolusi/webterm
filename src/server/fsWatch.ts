// Hub watcher direktori file manager (WS-FM-07, flag WATCH): satu `fs.watch(dir)` per direktori
// (refcount lintas klien), debounce, filter temp tulis-atomik + `.git`, petunjuk `{t:'fsdirty',dir}`.
// Gagal membuka watcher karena kehabisan descriptor / watcher mati di tengah jalan -> polling
// `readdir`. Dir di dalam repo juga memantau gitdir-nya (index/HEAD/FETCH_HEAD/...) dan `refs/` common
// dir-nya (rekursif; refcount per repo) supaya commit/add/checkout/push/fetch — yang tak mengubah
// working tree — tetap memicu `fsdirty`. Izin path = konvensi fsOps (`checkFsPath`: absolut, tanpa NUL, nama <=255 byte); fs API
// tidak punya root lain, jadi hub pun tidak (transport sudah loopback + Origin + token).
import { promises as fs, watch as nodeFsWatch } from 'node:fs'
import npath from 'node:path'
import type { ServerMsg } from '../shared/protocol'
import { errnoOf } from './fsAtomic'
import { checkFsPath } from './fsOps'
import { resolveGitDir, type GitDirs } from './fsGit'
import { filesFlagOn } from './envRegistry.files'
import { createLogger } from './logs'
import { produceFsChange } from './events/producers'

const log = createLogger('fs')

export type FsDirtySend = (m: ServerMsg) => void

/** Jendela debounce: satu burst perubahan = satu `fsdirty`. */
export const FS_WATCH_DEBOUNCE_MS = 150
/** Jeda polling `readdir` saat `fs.watch` tak tersedia. */
export const FS_WATCH_POLL_MS = 5000
/** Batas jumlah direktori yang dipantau sekaligus (watcher + poller); sisanya ditolak. */
export const FS_WATCH_MAX = 128

const TMP_RE = /^\.webterm-[\w-]+\.tmp$/ // pola temp `fsAtomic.ts`
const GIT_DIR = '.git'
// errno yang berarti "tak ada descriptor/watch tersisa" -> polling masih bisa; selain itu (ENOENT,
// EACCES, ...) polling pun gagal, jadi langganan ditolak.
const FALLBACK_ERRNO = new Set(['EMFILE', 'ENFILE', 'ENOSPC'])
const GONE_ERRNO = new Set(['ENOENT', 'ENOTDIR'])
/** gitdir-root entries that mean "git state changed": commit/add/reset rewrite `index`, checkout `HEAD`,
 *  fetch/pull `FETCH_HEAD`, merge/rebase/reset `ORIG_HEAD`, gc `packed-refs` (main repo only: a linked
 *  worktree's packed-refs lives in the common dir, whose loose-ref deletions the refs watcher sees).
 *  Branch tips (empty commit, push's remote-tracking update, fetch) move under `<common dir>/refs`. */
const GIT_STATE_FILES = new Set(['index', 'HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'packed-refs'])

/** Seam pemantau: panggil `onEvent(nama)` per perubahan, `onError` bila pemantau mati. */
export type WatchFn = (dir: string, onEvent: (name: string | null) => void, onError: (err: Error) => void, recursive?: boolean) => { close(): void }
/** Seam: gitdir + common dir of the repo containing `dir`, or null (not a repo / git status disabled). */
export type GitDirFn = (dir: string) => Promise<GitDirs | null>
export interface WatchHubOpts { watch?: WatchFn; debounceMs?: number; pollMs?: number; max?: number; gitDir?: GitDirFn }

const defaultGitDir: GitDirFn = (dir) => (filesFlagOn('GIT_STATUS') ? resolveGitDir(dir) : Promise.resolve(null))

const defaultWatch: WatchFn = (dir, onEvent, onError, recursive = false) => {
  const w = nodeFsWatch(dir, { persistent: false, recursive }, (_ev, name) => onEvent(name === null ? null : String(name)))
  w.on('error', onError)
  return w
}

/** Nama yang tak perlu memicu dirty: temp tulis atomik dan `.git`. */
function ignored(name: string | null): boolean {
  return name !== null && (name === GIT_DIR || TMP_RE.test(name))
}

interface Entry {
  key: string
  clients: Map<FsDirtySend, string> // send -> string dir persis seperti dikirim klien (dibalas apa adanya)
  closer: { close(): void } | null
  pollTimer: ReturnType<typeof setInterval> | null
  snapshot: string | null
  flushTimer: ReturnType<typeof setTimeout> | null
  /** Names seen in the current debounce window (empty for polling: it only sees the listing). */
  names: Set<string>
  /** The window saw a working-tree change (not only a gitdir one): only then is `fs.change` produced. */
  fsHit: boolean
  /** Shared git watchers this dir is attached to (its gitdir and its common dir's refs). */
  git: GitWatch[]
}

/** One watcher per gitdir (and per common-dir `refs/`), shared by every watched dir of that repo; counted against `max`. */
interface GitWatch { key: string; closer: { close(): void } | null; dirs: Set<Entry> }

/** Buat hub; opsi untuk tes (seam pemantau, jendela debounce, jeda poll, batas). */
export function createFsWatchHub(opts: WatchHubOpts = {}) {
  const watchFn = opts.watch ?? defaultWatch
  const debounceMs = opts.debounceMs ?? FS_WATCH_DEBOUNCE_MS
  const pollMs = opts.pollMs ?? FS_WATCH_POLL_MS
  const max = opts.max ?? FS_WATCH_MAX
  const gitDirFn = opts.gitDir ?? defaultGitDir
  const entries = new Map<string, Entry>()
  const gits = new Map<string, GitWatch>()

  function warn(msg: string, key: string, err: unknown): void {
    log.warn('fs.watch', msg, { file: npath.basename(key), code: errnoOf(err) || undefined })
  }

  function closeGit(g: GitWatch): void {
    g.closer?.close()
    g.closer = null
    gits.delete(g.key)
    for (const d of g.dirs) d.git = d.git.filter((x) => x !== g)
    g.dirs.clear()
  }

  function releaseGit(e: Entry): void {
    for (const g of e.git.splice(0)) if (g.dirs.delete(e) && g.dirs.size === 0) closeGit(g)
  }

  /** Attach `e` to the shared watcher on `path` (created on first use); `accept` filters event names. */
  function share(e: Entry, key: string, path: string, recursive: boolean, accept: (name: string | null) => boolean): void {
    let g = gits.get(key)
    if (!g) {
      if (entries.size + gits.size >= max) { log.warn('fs.watch', 'watcher limit reached, git state not watched', { max }); return }
      const fresh: GitWatch = { key, closer: null, dirs: new Set() }
      try {
        fresh.closer = watchFn(path,
          (name) => { if (accept(name)) for (const d of fresh.dirs) schedule(d, true) },
          (err) => { if (gits.get(key) === fresh) { warn('git watcher died, git state no longer watched', path, err); closeGit(fresh) } },
          recursive)
      } catch (err) { warn('git watch failed, git state not watched', path, err); return }
      gits.set(key, (g = fresh))
    }
    g.dirs.add(e)
    e.git.push(g)
  }

  /** Attach `e` to its repo's gitdir + refs watchers. Failure = no git refresh, dir watch kept. */
  async function attachGit(e: Entry): Promise<void> {
    let gd: GitDirs | null
    try { gd = await gitDirFn(e.key) } catch (err) { warn('gitdir lookup failed, git state not watched', e.key, err); return }
    if (!gd || entries.get(e.key) !== e) return
    share(e, `dir:${gd.gitDir}`, gd.gitDir, false, (name) => name === null || GIT_STATE_FILES.has(name))
    share(e, `refs:${gd.commonDir}`, npath.join(gd.commonDir, 'refs'), true, () => true)
  }

  function dispose(e: Entry): void {
    releaseGit(e)
    if (e.flushTimer) clearTimeout(e.flushTimer)
    if (e.pollTimer) clearInterval(e.pollTimer)
    e.closer?.close()
    e.flushTimer = e.pollTimer = e.closer = null
    e.clients.clear()
    entries.delete(e.key)
  }

  function notify(e: Entry): void {
    for (const [send, dir] of e.clients) {
      try { send({ t: 'fsdirty', dir }) } catch (err) { warn('fsdirty send failed', e.key, err) }
    }
  }

  /** Akhir jendela debounce: kirim dirty; bila direktorinya sudah hilang, lepas entri (sekali kirim). */
  async function flush(e: Entry): Promise<void> {
    e.flushTimer = null
    const gone = await fs.stat(e.key).then(() => false, (err: unknown) => GONE_ERRNO.has(errnoOf(err)))
    if (entries.get(e.key) !== e) return // dilepas selama await
    notify(e)
    // Senses: one `fs.change` per burst (the producer debounces further per directory); a gitdir-only
    // burst (commit/add) changed nothing in the directory itself.
    if (e.fsHit) produceFsChange(e.key, e.names)
    e.names = new Set()
    e.fsHit = false
    if (gone) dispose(e)
  }

  function schedule(e: Entry, fromGit = false): void {
    if (!fromGit) e.fsHit = true
    if (!e.flushTimer) e.flushTimer = setTimeout(() => { void flush(e) }, debounceMs)
  }

  /** Daftar nama (tanpa yang diabaikan); null bila tak terbaca / hilang. */
  function snapshotOf(key: string): Promise<string | null> {
    return fs.readdir(key).then((names) => names.filter((n) => !ignored(n)).sort().join('\n'), () => null)
  }

  // ponytail: polling hanya melihat nama entri (tambah/hapus/rename), bukan isi file; upgrade ke stat per entri bila perlu.
  function startPolling(e: Entry): void {
    e.closer?.close()
    e.closer = null
    if (e.pollTimer) clearInterval(e.pollTimer)
    void snapshotOf(e.key).then((s) => { if (e.snapshot === null) e.snapshot = s })
    e.pollTimer = setInterval(() => {
      void snapshotOf(e.key).then((s) => {
        if (entries.get(e.key) !== e || e.flushTimer || s === e.snapshot) return
        e.snapshot = s
        schedule(e)
      })
    }, pollMs)
    e.pollTimer.unref?.()
  }

  function start(e: Entry): void {
    e.closer = watchFn(
      e.key,
      (name) => {
        if (ignored(name)) return
        if (name !== null) e.names.add(name)
        schedule(e)
      },
      (err) => {
        if (entries.get(e.key) !== e) return
        warn('watcher died, falling back to polling', e.key, err)
        startPolling(e)
        schedule(e) // ada yang mungkin terlewat; flush juga menangkap direktori yang hilang
      },
    )
    // Bun tidak mengirim event saat direktori yang dipantau dihapus (Node di macOS: 'change'), jadi
    // cek keberadaan berkala; `flush` yang menjatuhkan entrinya.
    e.pollTimer = setInterval(() => {
      void fs.stat(e.key).catch((err: unknown) => { if (GONE_ERRNO.has(errnoOf(err))) schedule(e) })
    }, pollMs)
    e.pollTimer.unref?.()
  }

  return {
    /** Langganan `send` ke perubahan `dir` (refcount); path tak sah / di atas batas / tak bisa dipantau diabaikan. */
    watch(send: FsDirtySend, dir: string): void {
      const key = checkFsPath(dir)
      if (typeof key !== 'string') return
      const existing = entries.get(key)
      if (existing) { existing.clients.set(send, dir); return }
      if (entries.size + gits.size >= max) { log.warn('fs.watch', 'watcher limit reached, subscription ignored', { max }); return }
      const e: Entry = { key, clients: new Map([[send, dir]]), closer: null, pollTimer: null, snapshot: null, flushTimer: null, names: new Set<string>(), fsHit: false, git: [] }
      try {
        start(e)
      } catch (err) {
        if (!FALLBACK_ERRNO.has(errnoOf(err))) { warn('watch failed, subscription ignored', key, err); return }
        warn('watch failed, falling back to polling', key, err)
        startPolling(e)
      }
      entries.set(key, e)
      void attachGit(e)
    },
    /** Lepas langganan `send` atas `dir`; watcher ditutup bila itu klien terakhir. */
    unwatch(send: FsDirtySend, dir: string): void {
      const key = checkFsPath(dir)
      const e = typeof key === 'string' ? entries.get(key) : undefined
      if (!e) return
      e.clients.delete(send)
      if (e.clients.size === 0) dispose(e)
    },
    /** Lepas SEMUA langganan milik `send` (ws tutup). */
    dropClient(send: FsDirtySend): void {
      for (const e of [...entries.values()]) {
        e.clients.delete(send)
        if (e.clients.size === 0) dispose(e)
      }
    },
    /** Jumlah direktori yang sedang dipantau (untuk tes kebocoran). */
    size(): number { return entries.size },
    /** Number of git watchers open (gitdir + refs; leak tests). */
    gitSize(): number { return gits.size },
  }
}

export const fsWatchHub = createFsWatchHub()
