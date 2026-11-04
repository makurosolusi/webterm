// Pemindai inkremental transcript agent ke indeks `agent_session`.
//
// Ditiru dari Orca `src/main/ai-vault/` (session-scanner + parse-cache): file yang mtime+size-nya
// tidak berubah dilewati; file yang hanya BERTAMBAH (JSONL append-only) di-parse mulai
// `parsed_bytes` dan state lama disambung; file yang menyusut di-parse ulang dari nol. Dengan begitu
// transcript ratusan MB hanya dibaca penuh sekali, dan tak pernah dimuat utuh ke memori (stream).
import { createReadStream, readdirSync, statSync } from 'node:fs'
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

/** Baca baris utuh mulai `offset`. Mengembalikan byte terakhir yang benar-benar terpakai: baris
 *  ekor tanpa newline yang belum JSON utuh (CLI sedang menulis) tidak dihitung, jadi scan berikut
 *  membacanya lagi. */
export async function readLinesFrom(path: string, offset: number, onLine: (l: string) => void): Promise<number> {
  let consumed = offset
  let rest = Buffer.alloc(0)
  for await (const chunk of createReadStream(path, { start: offset })) {
    let buf = Buffer.concat([rest, chunk as Buffer])
    let nl: number
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      onLine(buf.subarray(0, nl).toString('utf8'))
      consumed += nl + 1
      buf = buf.subarray(nl + 1)
    }
    rest = buf
  }
  if (rest.length) {
    const tail = rest.toString('utf8')
    try {
      JSON.parse(tail)
      onLine(tail)
      consumed += rest.length
    } catch {
      // ekor setengah-tulis: biarkan untuk scan berikutnya
    }
  }
  return consumed
}

async function indexFile(db: HistoryDb, agent: HistoryAgent, path: string): Promise<void> {
  const st = statSync(path)
  const prev = getIndexed(db, path)
  if (prev && prev.mtimeMs === Math.trunc(st.mtimeMs) && prev.size === st.size) return
  const resume = prev && prev.agent === agent && st.size >= prev.parsedBytes
  const state: SessionParseState = resume
    ? { agent, id: prev.id, cwd: prev.cwd, title: prev.title, startedAt: prev.startedAt, endedAt: prev.endedAt, messageCount: prev.messageCount }
    : newParseState(agent, sessionIdFromFile(agent, basename(path)))
  const parsedBytes = await readLinesFrom(path, resume ? prev.parsedBytes : 0, (l) => consumeLine(state, l))
  const row: IndexedFile = { ...state, path, mtimeMs: Math.trunc(st.mtimeMs), size: st.size, parsedBytes }
  putIndexed(db, row)
}

/**
 * Perbarui indeks dari semua root. Satu file yang gagal dibaca (izin, hilang di tengah scan) tidak
 * menggagalkan yang lain: ia dicatat dan dilewati, dan baris lamanya dipertahankan.
 */
export async function scanSessions(db: HistoryDb, roots: readonly ScanRoot[] = defaultRoots()): Promise<void> {
  const present = new Set<string>()
  for (const root of roots) {
    for (const path of listTranscripts(root)) {
      present.add(path)
      try {
        await indexFile(db, root.agent, path)
      } catch (e) {
        console.warn(`session history: index ${root.agent} transcript failed (${(e as NodeJS.ErrnoException).code ?? 'parse'})`)
      }
    }
  }
  pruneIndexed(db, present)
}
