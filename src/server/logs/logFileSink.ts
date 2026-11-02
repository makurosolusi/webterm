// Daily-rotated log file writer. Writes are batched and asynchronous (never blocks the event loop on
// the hot path); a bounded queue drops the oldest lines under pressure and counts them. Failures are
// reported once on stderr per failure streak and never thrown into the caller.
import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LogEntry } from '../../shared/logEntry'

export const LOG_FILE_PREFIX = 'webterm-'
export const LOG_FILE_SUFFIX = '.log'
export const DEFAULT_MAX_FILES = 7
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_QUEUE_LINES = 5000
const FLUSH_DELAY_MS = 100

export interface FileSinkOptions {
  dir: string
  maxFiles?: number
  maxFileBytes?: number
  /** Injectable clock for tests. */
  now?: () => Date
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** Local calendar date, `YYYY-MM-DD`. */
export function dayStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const FILE_NAME = /^webterm-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/
const ACTIVE_RANK = '9'.repeat(16)

/** Chronological key: day, then rotation time (the live file of a day is its newest); null = not ours. */
function sortKey(name: string): string | null {
  const m = FILE_NAME.exec(name)
  return m ? `${m[1]}|${m[2] ? m[2].padStart(16, '0') : ACTIVE_RANK}` : null
}

export function createFileSink(options: FileSinkOptions) {
  const { dir, maxFiles = DEFAULT_MAX_FILES, maxFileBytes = DEFAULT_MAX_FILE_BYTES, now = () => new Date() } = options
  let queue: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<void> = Promise.resolve()
  let dirReady = false
  let day = ''
  let size = 0
  let failing = false
  let droppedLines = 0

  const fileFor = (stamp: string): string => join(dir, `${LOG_FILE_PREFIX}${stamp}${LOG_FILE_SUFFIX}`)

  function reportFailure(err: unknown): void {
    if (failing) return
    failing = true
    process.stderr.write(`log file sink failed (${dir}): ${err instanceof Error ? err.message : String(err)}\n`)
  }

  async function prune(): Promise<void> {
    const ours = (await readdir(dir)).map((name) => ({ name, key: sortKey(name) })).filter((f) => f.key !== null)
    ours.sort((a, b) => (b.key as string).localeCompare(a.key as string))
    await Promise.all(ours.slice(maxFiles).map((f) => unlink(join(dir, f.name))))
  }

  /** Start-of-write bookkeeping: a new day re-reads the size; an oversized file is renamed aside first. */
  async function prepare(stamp: string, incoming: number): Promise<string> {
    if (!dirReady) { await mkdir(dir, { recursive: true }); dirReady = true }
    const path = fileFor(stamp)
    if (day !== stamp) {
      day = stamp
      size = await stat(path).then((s) => s.size, () => 0)
    }
    if (size > 0 && size + incoming > maxFileBytes) {
      await rename(path, join(dir, `${LOG_FILE_PREFIX}${stamp}.${now().getTime()}${LOG_FILE_SUFFIX}`))
      size = 0
    }
    return path
  }

  async function writeBatch(lines: string[]): Promise<void> {
    const text = `${lines.join('\n')}\n`
    try {
      const bytes = Buffer.byteLength(text)
      const path = await prepare(dayStamp(now()), bytes)
      const fresh = size === 0
      await appendFile(path, text)
      size += bytes
      // Prune after the append so the new file counts toward `maxFiles`.
      if (fresh) await prune()
      failing = false
    } catch (err) {
      reportFailure(err)
    }
  }

  function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null }
    if (queue.length > 0) {
      const batch = queue
      queue = []
      inflight = inflight.then(() => writeBatch(batch))
    }
    return inflight
  }

  return {
    /** Queue one entry as a JSON line; schedules an asynchronous flush. */
    write(entry: LogEntry): void {
      if (queue.length >= MAX_QUEUE_LINES) { queue.shift(); droppedLines += 1 }
      queue.push(JSON.stringify(entry))
      if (!timer) {
        timer = setTimeout(() => { void flush() }, FLUSH_DELAY_MS)
        timer.unref?.()
      }
    },
    /** Resolve once everything queued so far is on disk. */
    flush,
    /** Blocking flush for process exit, where async work would never run. */
    flushSync(): void {
      if (queue.length === 0) return
      const text = `${queue.join('\n')}\n`
      queue = []
      try {
        mkdirSync(dir, { recursive: true })
        appendFileSync(fileFor(dayStamp(now())), text)
      } catch (err) {
        reportFailure(err)
      }
    },
    get droppedLines(): number { return droppedLines },
    get dir(): string { return dir },
  }
}

export type FileSink = ReturnType<typeof createFileSink>
