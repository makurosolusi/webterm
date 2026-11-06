// Pemindai inkremental transcript agent ke indeks `agent_session`.
//
// Ditiru dari Orca `src/main/ai-vault/` (session-scanner + parse-cache): file yang mtime+size-nya
// tidak berubah dilewati; file yang hanya BERTAMBAH (JSONL append-only) di-parse mulai
// `parsed_bytes` dan state lama disambung; file yang menyusut di-parse ulang dari nol. Dengan begitu
// transcript ratusan MB hanya dibaca penuh sekali, dan tak pernah dimuat utuh ke memori (stream).
import { readdirSync } from 'node:fs'
import { constants, lstat, open, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { claudeProjectsRoot } from './transcriptPresence'
import { consumeLine, newParseState, sessionIdFromFile, type HistoryAgent, type SessionParseState } from './sessionHistory.parse'
import { getIndexed, pruneIndexed, putIndexed, type HistoryDb, type IndexedFile } from './sessionHistory.store'

export interface ScanRoot {
  agent: HistoryAgent
  dir: string
}

/** Root transcript yang dikenal. Codex menghormati `CODEX_HOME` (override resmi codex). */
export function defaultRoots(): ScanRoot[] {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return [
    { agent: 'claude', dir: claudeProjectsRoot() },
    { agent: 'codex', dir: join(codexHome, 'sessions') },
  ]
}

/** File `.jsonl` milik satu root. Claude: `<root>/<project>/<id>.jsonl` saja (subagent di
 *  subdirektori bukan sesi yang bisa di-resume). Codex: `sessions/YYYY/MM/DD/rollout-*.jsonl`. */
export function listTranscripts(root: ScanRoot): string[] {
  let names: string[]
  try {
    names = root.agent === 'codex'
      ? (readdirSync(root.dir, { recursive: true }) as string[])
      : readdirSync(root.dir).flatMap((p) => {
          try {
            return readdirSync(join(root.dir, p)).map((f) => join(p, f))
          } catch {
            return [] // entri bukan direktori (mis. file lepas di root): bukan project dir
          }
        })
  } catch {
    return [] // root belum ada (CLI tidak terpasang): tidak ada sesi, bukan galat
  }
  return names.filter((n) => n.endsWith('.jsonl')).map((n) => join(root.dir, n))
}

/** Bytes read from one transcript per scan. A larger backlog is finished by later scans (the row
 *  records how far it got), so one huge file cannot hold a scan for long. */
export const SCAN_FILE_READ_MAX_BYTES = 64 * 1024 * 1024
/** Longest JSONL line kept in memory. A longer one (corrupt or hostile file) is skipped, not buffered. */
export const SCAN_LINE_MAX_BYTES = 16 * 1024 * 1024
const READ_CHUNK_BYTES = 1024 * 1024

/** Read whole lines of `fh` in `[offset, end)`. Returns the last byte actually consumed: a tail with
 *  no newline is only taken when the window ends at EOF and it is complete JSON (otherwise the CLI is
 *  still writing it, and the next scan reads it again). A line over `SCAN_LINE_MAX_BYTES` is skipped. */
export async function readLinesFrom(
  fh: FileHandle, offset: number, end: number, atEof: boolean, onLine: (l: string) => void, signal?: AbortSignal,
): Promise<number> {
  let consumed = offset
  let rest = Buffer.alloc(0)
  let skipping = false
  const chunk = Buffer.alloc(READ_CHUNK_BYTES)
  for (let pos = offset; pos < end;) {
    signal?.throwIfAborted()
    const { bytesRead } = await fh.read(chunk, 0, Math.min(READ_CHUNK_BYTES, end - pos), pos)
    if (bytesRead === 0) break // truncated under us: stop at what exists
    pos += bytesRead
    let buf = rest.length ? Buffer.concat([rest, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
    let nl: number
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      if (!skipping) onLine(buf.subarray(0, nl).toString('utf8'))
      skipping = false
      consumed += nl + 1
      buf = buf.subarray(nl + 1)
    }
    if (skipping || buf.length > SCAN_LINE_MAX_BYTES) {
      skipping = true
      consumed += buf.length
      rest = Buffer.alloc(0)
    } else rest = Buffer.from(buf) // copy: `chunk` is reused by the next read
  }
  if (rest.length && atEof) {
    const tail = rest.toString('utf8')
    try {
      JSON.parse(tail)
      onLine(tail)
      consumed += rest.length
    } catch {
      // half-written tail: leave it for the next scan
    }
  }
  return consumed
}

async function indexFile(db: HistoryDb, agent: HistoryAgent, path: string, signal?: AbortSignal): Promise<void> {
  // Regular files only, like `readTranscriptFile`: a FIFO, device or symlink (to `/dev/zero`, say)
  // under an agent-writable root would block or never end. `O_NONBLOCK` keeps a FIFO swapped in after
  // the lstat from blocking `open`, `O_NOFOLLOW` refuses a swapped-in symlink, `fstat` confirms.
  if (!(await lstat(path)).isFile()) return
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = await fh.stat()
    if (!st.isFile()) return
    const prev = getIndexed(db, path)
    if (prev && prev.mtimeMs === Math.trunc(st.mtimeMs) && prev.size === st.size) return
    const resume = prev && prev.agent === agent && st.size >= prev.parsedBytes
    const state: SessionParseState = resume
      ? { agent, id: prev.id, cwd: prev.cwd, title: prev.title, startedAt: prev.startedAt, endedAt: prev.endedAt, messageCount: prev.messageCount }
      : newParseState(agent, sessionIdFromFile(agent, basename(path)))
    const from = resume ? prev.parsedBytes : 0
    // Read up to the size seen now: bytes appended during the read belong to the next scan.
    const end = Math.min(st.size, from + SCAN_FILE_READ_MAX_BYTES)
    const parsedBytes = await readLinesFrom(fh, from, end, end === st.size, (l) => consumeLine(state, l), signal)
    // A capped read records the window end as its size, so the next scan sees a change and continues.
    const row: IndexedFile = { ...state, path, mtimeMs: Math.trunc(st.mtimeMs), size: end, parsedBytes }
    putIndexed(db, row)
  } finally {
    await fh.close()
  }
}

/**
 * Perbarui indeks dari semua root. Satu file yang gagal dibaca (izin, hilang di tengah scan) tidak
 * menggagalkan yang lain: ia dicatat dan dilewati, dan baris lamanya dipertahankan. An aborted scan
 * rejects with the signal's reason and prunes nothing (the list of present files is incomplete);
 * every file it finished stays indexed.
 */
export async function scanSessions(db: HistoryDb, roots: readonly ScanRoot[] = defaultRoots(), signal?: AbortSignal): Promise<void> {
  const present = new Set<string>()
  for (const root of roots) {
    for (const path of listTranscripts(root)) {
      signal?.throwIfAborted()
      present.add(path)
      try {
        await indexFile(db, root.agent, path, signal)
      } catch (e) {
        if (signal?.aborted) throw e
        console.warn(`session history: index ${root.agent} transcript failed (${(e as NodeJS.ErrnoException).code ?? 'parse'})`)
      }
    }
  }
  signal?.throwIfAborted()
  pruneIndexed(db, present)
}
