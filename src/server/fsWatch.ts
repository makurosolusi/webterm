// Hub watcher direktori file manager (WS-FM-07, flag WATCH): satu `fs.watch(dir)` per direktori
// (refcount lintas klien), debounce, filter temp tulis-atomik + `.git`, petunjuk `{t:'fsdirty',dir}`.
// Gagal membuka watcher karena kehabisan descriptor / watcher mati di tengah jalan -> polling
// `readdir`. Izin path = konvensi fsOps (`checkFsPath`: absolut, tanpa NUL, nama <=255 byte); fs API
// tidak punya root lain, jadi hub pun tidak (transport sudah loopback + Origin + token).
import { promises as fs, watch as nodeFsWatch } from 'node:fs'
import npath from 'node:path'
import type { ServerMsg } from '../shared/protocol'
import { errnoOf } from './fsAtomic'
import { checkFsPath } from './fsOps'
import { createLogger } from './logs'

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

/** Seam pemantau: panggil `onEvent(nama)` per perubahan, `onError` bila pemantau mati. */
export type WatchFn = (dir: string, onEvent: (name: string | null) => void, onError: (err: Error) => void) => { close(): void }
export interface WatchHubOpts { watch?: WatchFn; debounceMs?: number; pollMs?: number; max?: number }

const defaultWatch: WatchFn = (dir, onEvent, onError) => {
  const w = nodeFsWatch(dir, { persistent: false }, (_ev, name) => onEvent(name === null ? null : String(name)))
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
}

/** Buat hub; opsi untuk tes (seam pemantau, jendela debounce, jeda poll, batas). */
export function createFsWatchHub(opts: WatchHubOpts = {}) {
  const watchFn = opts.watch ?? defaultWatch
  const debounceMs = opts.debounceMs ?? FS_WATCH_DEBOUNCE_MS
  const pollMs = opts.pollMs ?? FS_WATCH_POLL_MS
  const max = opts.max ?? FS_WATCH_MAX
  const entries = new Map<string, Entry>()

  function warn(msg: string, key: string, err: unknown): void {
    log.warn('fs.watch', msg, { file: npath.basename(key), code: errnoOf(err) || undefined })
  }

  function dispose(e: Entry): void {
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
    if (gone) dispose(e)
  }

  function schedule(e: Entry): void {
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
      (name) => { if (!ignored(name)) schedule(e) },
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
      if (entries.size >= max) { log.warn('fs.watch', 'watcher limit reached, subscription ignored', { max }); return }
      const e: Entry = { key, clients: new Map([[send, dir]]), closer: null, pollTimer: null, snapshot: null, flushTimer: null }
      try {
        start(e)
      } catch (err) {
        if (!FALLBACK_ERRNO.has(errnoOf(err))) { warn('watch failed, subscription ignored', key, err); return }
        warn('watch failed, falling back to polling', key, err)
        startPolling(e)
      }
      entries.set(key, e)
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
  }
}

export const fsWatchHub = createFsWatchHub()
