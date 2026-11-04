// External anchor for the Senses hash chain (PLAN K9). Like a CT log's published tree head: the
// latest {seq, hash} is copied OUTSIDE ledger.db so that recomputing the whole chain after an
// edit, or dropping the newest rows, no longer matches what was recorded earlier.
//
// Honest limit: the anchor file lives in the data dir and is writable by the same uid as the
// server, so an attacker with that uid can rewrite both. Real protection needs a store outside
// that reach (Keychain item with an ACL, a remote witness such as Telegram); that is new infra
// and out of scope here. What this gives today: an anchor that survives ledger.db being replaced
// or rewritten on its own, plus the head hash exposed at GET /api/events/head so the user (and
// later the UI) can notice a divergence.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChainHead } from './eventModel'

export interface EventAnchor extends ChainHead {
  /** When the anchor was written (ms since epoch). */
  at: number
}

/** `match`: anchored row still has the anchored hash. `rewritten`: same seq, different hash. `truncated`: anchored row is gone. */
export type AnchorStatus = 'no_anchor' | 'match' | 'rewritten' | 'truncated'

export const ANCHOR_FILE = 'event-anchor.json'
export const ANCHOR_INTERVAL_MS = 30_000
const HASH_RE = /^[0-9a-f]{64}$/

/** Atomic (temp + rename) owner-only write. */
export function writeAnchor(file: string, anchor: EventAnchor): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(anchor)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}

/** The stored anchor, null when there is none yet. A malformed file throws: that is itself a divergence signal. */
export function readAnchor(file: string): EventAnchor | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null
    throw new Error(`readAnchor ${file}: cannot read`, { cause: err })
  }
  let parsed: Partial<EventAnchor>
  try {
    parsed = JSON.parse(raw) as Partial<EventAnchor>
  } catch (err) {
    throw new Error(`readAnchor ${file}: not JSON`, { cause: err })
  }
  if (!Number.isSafeInteger(parsed.seq) || typeof parsed.hash !== 'string' || !HASH_RE.test(parsed.hash) || !Number.isFinite(parsed.at)) {
    throw new Error(`readAnchor ${file}: malformed anchor`)
  }
  return { seq: parsed.seq as number, hash: parsed.hash, at: parsed.at as number }
}

/** Compares an anchor with the log via the stored hash of the anchored row. */
export function anchorStatus(anchor: EventAnchor | null, hashAt: (seq: number) => string | null): AnchorStatus {
  if (anchor === null) return 'no_anchor'
  const stored = hashAt(anchor.seq)
  if (stored === null) return 'truncated'
  return stored === anchor.hash ? 'match' : 'rewritten'
}

/**
 * Throttled anchor writer: `schedule()` after an append writes the current head at most once per
 * `intervalMs` (unref'd timer, never keeps the process alive). `flush()` writes now.
 * ponytail: appends in the last interval before a crash are not anchored; the chain still covers them.
 */
export function createAnchorWriter(
  file: string,
  getHead: () => ChainHead | null,
  onError: (err: unknown) => void,
  intervalMs = ANCHOR_INTERVAL_MS,
  now: () => number = Date.now
) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    try {
      const head = getHead()
      if (head) writeAnchor(file, { ...head, at: now() })
    } catch (err) {
      onError(err)
    }
  }
  return {
    flush,
    schedule(): void {
      if (timer) return
      timer = setTimeout(flush, intervalMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    },
    stop(): void {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
