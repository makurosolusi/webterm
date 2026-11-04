// Broker secrets: the existing 0600 file store (envSecrets.store.ts) in its OWN directory, so the server's
// env secrets (Telegram token, ...) are never listable or injectable. Usage is read back from the
// `secret.use` events (Senses log), so "last used" and the usage log have one source of truth.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { dataDir } from '../config'
import { createFileSecretStore, type SecretStore } from '../envSecrets.store'
import { allRows } from '../ledger/ledgerCore'
import { SECRET_NAME_PATTERN } from './secret.capabilities'

export const SECRET_USE_EVENT = 'secret.use'
export const BROKER_SUBDIR = 'secrets-broker'
export const SECRET_SUBJECT_PREFIX = 'secret:'
const NAME_RE = new RegExp(SECRET_NAME_PATTERN)

export interface BrokerStore extends SecretStore {
  /** Stored secret names, sorted. */
  names(): string[]
}

/** Broker store over `dir` (default `<data dir>/secrets-broker`, created 0700 on first write). */
export function createBrokerStore(dir = join(dataDir(), BROKER_SUBDIR)): BrokerStore {
  const files = createFileSecretStore(dir)
  return {
    ...files,
    names: () => (existsSync(dir) ? readdirSync(dir).filter((n) => NAME_RE.test(n)).sort() : []),
  }
}

export interface SecretUsage { seq: number; ts: number; name: string; principal: string; commandHash: string; exitCode: number | null }

/** Last `secret.use` time per secret name. */
export function lastUsedByName(db: Database): Map<string, number> {
  const rows = allRows(db, 'SELECT subject, MAX(ts) AS ts FROM event WHERE kind = ? AND hash IS NOT NULL GROUP BY subject', SECRET_USE_EVENT)
  return new Map(rows.map((r) => [String(r.subject).slice(SECRET_SUBJECT_PREFIX.length), Number(r.ts)]))
}

/** Newest `secret.use` events first, at most `limit`. */
export function usageLog(db: Database, limit: number): SecretUsage[] {
  return allRows(db, 'SELECT seq, ts, actor, payload_json FROM event WHERE kind = ? AND hash IS NOT NULL ORDER BY seq DESC LIMIT ?', SECRET_USE_EVENT, limit)
    .map((r) => {
      const p = JSON.parse(String(r.payload_json ?? '{}')) as { name?: string; commandHash?: string; exitCode?: number | null }
      return { seq: Number(r.seq), ts: Number(r.ts), name: String(p.name ?? ''), principal: String(r.actor), commandHash: String(p.commandHash ?? ''), exitCode: p.exitCode ?? null }
    })
}
