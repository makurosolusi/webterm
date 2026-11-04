/**
 * `embed_cache` (ledger v19): a vector is keyed by sha256(model id + normalised text), so the same text is
 * never embedded twice for one model (PLAN/rnd/03 §3). Bounded: past `EMBED_CACHE_MAX` rows the least
 * recently used are dropped on write.
 */
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { allRows, execWrite, getRow } from '../../ledger/ledgerCore'
import type { Embedder } from './embedLocal'

export const EMBED_CACHE_MAX = 20_000
/** Memories warmed per idle prefetch pass. */
export const PREFETCH_BATCH = 200

const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()

export function embedKey(modelId: string, text: string): string {
  return createHash('sha256').update(`${modelId}\0${normalise(text)}`).digest('hex')
}

const toBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
/** Copy first: a BLOB's byteOffset need not be 4-aligned. */
const fromBlob = (b: unknown): Float32Array => new Float32Array(new Uint8Array(b as Uint8Array).slice().buffer)

/** Vectors for `texts` in order; cache misses go to the embedder in one batch and are stored. */
export function embedTexts(db: Database, embedder: Embedder, texts: readonly string[], now: number): Float32Array[] {
  const keys = texts.map((t) => embedKey(embedder.modelId, t))
  const found = new Map<string, Float32Array>()
  const unique = [...new Set(keys)]
  if (unique.length > 0) {
    const rows = allRows(db, `SELECT key, vec FROM embed_cache WHERE dim = ? AND key IN (${unique.map(() => '?').join(',')})`, embedder.dim, ...unique)
    for (const r of rows) found.set(String(r['key']), fromBlob(r['vec']))
    if (rows.length > 0) execWrite(db, `UPDATE embed_cache SET last_used_at = ? WHERE key IN (${rows.map(() => '?').join(',')})`, now, ...rows.map((r) => r['key']))
  }
  const missing = unique.filter((k) => !found.has(k))
  if (missing.length > 0) {
    const textOf = new Map(keys.map((k, i) => [k, texts[i]!]))
    const vecs = embedder.embed(missing.map((k) => textOf.get(k)!))
    missing.forEach((k, i) => {
      const vec = vecs[i]
      if (!vec || vec.length !== embedder.dim) throw new Error(`embedder ${embedder.modelId} returned no ${embedder.dim}-dim vector for item ${i}`)
      found.set(k, vec)
      execWrite(db, `INSERT OR REPLACE INTO embed_cache (key, model_id, dim, vec, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)`,
        k, embedder.modelId, embedder.dim, toBlob(vec), now, now)
    })
    trim(db)
  }
  return keys.map((k) => found.get(k)!)
}

function trim(db: Database): void {
  const n = Number(getRow(db, 'SELECT COUNT(*) AS n FROM embed_cache')?.['n'] ?? 0)
  if (n <= EMBED_CACHE_MAX) return
  execWrite(db, 'DELETE FROM embed_cache WHERE key IN (SELECT key FROM embed_cache ORDER BY last_used_at ASC LIMIT ?)', n - EMBED_CACHE_MAX)
}

/** Text a memory row is embedded from (same for the search leg and the prefetch). */
export const memoryEmbedText = (row: Record<string, unknown>): string => `${String(row['title'] ?? '')}\n${String(row['body'] ?? '')}`

/**
 * Speculative prefetch: embeds the most recently touched live memories ahead of the next search, so the
 * embedding leg is a pure cache read on the hot path. Bounded by `limit`; returns how many were scanned.
 */
export function prefetchMemoryEmbeddings(db: Database, embedder: Embedder, now: number, limit = PREFETCH_BATCH): number {
  const rows = allRows(db, `SELECT title, body FROM memory WHERE superseded_at IS NULL AND suppressed_at IS NULL
    ORDER BY COALESCE(last_used_at, updated_at) DESC LIMIT ?`, limit)
  embedTexts(db, embedder, rows.map(memoryEmbedText), now)
  return rows.length
}
