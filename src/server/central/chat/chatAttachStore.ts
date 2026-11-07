// Disk store of Central chat attachments (images and inlined text files): one folder per conversation
// under `<data dir>/central/attachments/`, each blob named by the SHA-256 of its bytes, so a message part
// holds a reference and never the bytes. A blob's mtime is "last referenced": storing the same bytes
// again (a new send or a Retry) touches it. Blobs unreferenced for CENTRAL_ATTACH_TTL_MS are swept
// lazily on a store, at most once per CENTRAL_ATTACH_SWEEP_EVERY_MS, with a bounded number of entries.
// There is no conversation delete in Central today; the sweep is the only cleanup.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../../config'
import { errnoOf } from '../../fsAtomic'
import { createLogger } from '../../logs'

const log = createLogger('central')

/** A blob not stored or re-sent for this long is removed; its history thumbnail/chip stays, the bytes go. */
export const CENTRAL_ATTACH_TTL_MS = 30 * 24 * 60 * 60_000
/** Least time between two sweeps of one process. */
export const CENTRAL_ATTACH_SWEEP_EVERY_MS = 60 * 60_000
/** Entries (folders + files) one sweep looks at, so a huge store never stalls a send. */
export const CENTRAL_ATTACH_SWEEP_MAX_ENTRIES = 2_000

const REF = /^[0-9a-f]{64}$/
let lastSweep = 0

/** Root of the store (read per call: the data dir is an env setting). */
export function attachRoot(): string {
  return join(dataDir(), 'central', 'attachments')
}

/** One folder per conversation, named by a hash (conversation ids hold `:`). */
function conversationDir(conversationId: string): string {
  return join(attachRoot(), createHash('sha256').update(conversationId).digest('hex').slice(0, 32))
}

/** Stores `bytes` once for this conversation (re-storing touches it) and answers its reference. */
export function storeBlob(conversationId: string, bytes: Buffer, now = Date.now()): string {
  const dir = conversationDir(conversationId)
  const ref = createHash('sha256').update(bytes).digest('hex')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, ref)
  try {
    writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if (errnoOf(err) !== 'EEXIST') throw new Error(`central: could not store attachment ${ref.slice(0, 8)} for ${conversationId}: ${errnoOf(err) || 'unknown'}`, { cause: err })
    // Same bytes referenced again: the TTL restarts.
    utimesSync(file, now / 1000, now / 1000)
  }
  sweepIfDue(now)
  return ref
}

/** Bytes of a stored blob of this conversation; undefined = unknown, malformed or swept ref. */
export function readBlob(conversationId: string, ref: string): Buffer | undefined {
  if (!REF.test(ref)) return undefined
  try {
    return readFileSync(join(conversationDir(conversationId), ref))
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return undefined
    throw new Error(`central: could not read attachment ${ref.slice(0, 8)} of ${conversationId}: ${errnoOf(err) || 'unknown'}`, { cause: err })
  }
}

function sweepIfDue(now: number): void {
  if (now - lastSweep < CENTRAL_ATTACH_SWEEP_EVERY_MS) return
  lastSweep = now
  try {
    sweepAttachments(now)
  } catch (err) {
    // The blob is stored either way: a failed sweep is logged, never the send's failure.
    log.warn('central.attach_sweep_failed', 'central attachment sweep failed', { error: errnoOf(err) || (err instanceof Error ? err.name : typeof err) })
  }
}

/** Removes blobs older than the TTL and folders left empty; looks at most at `maxEntries` entries. Answers the removed count. */
export function sweepAttachments(now = Date.now(), maxEntries = CENTRAL_ATTACH_SWEEP_MAX_ENTRIES): number {
  const root = attachRoot()
  let seen = 0
  let removed = 0
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir)
    } catch (err) {
      if (errnoOf(err) === 'ENOENT') return []
      throw err
    }
  }
  for (const folder of list(root)) {
    if (++seen > maxEntries) break
    const dir = join(root, folder)
    let left = 0
    for (const name of list(dir)) {
      if (++seen > maxEntries) return removed
      const st = statSync(join(dir, name), { throwIfNoEntry: false })
      if (st?.isFile() && now - st.mtimeMs > CENTRAL_ATTACH_TTL_MS) {
        rmSync(join(dir, name), { force: true })
        removed++
      } else {
        left++
      }
    }
    if (left === 0) {
      try {
        rmdirSync(dir)
      } catch (err) {
        // A send stored a blob in it meanwhile, or it is not a folder: keep it.
        if (errnoOf(err) !== 'ENOTEMPTY' && errnoOf(err) !== 'ENOTDIR' && errnoOf(err) !== 'ENOENT') throw err
      }
    }
  }
  return removed
}

/** Test seam: the next store sweeps regardless of the last one. */
export function resetSweepClock(): void {
  lastSweep = 0
}
