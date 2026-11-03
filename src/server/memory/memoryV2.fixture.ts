/** Shared bun:sqlite fixture for the WS-08 memory tests (test-only; not imported by production code). */
import type { Database } from 'bun:sqlite'
import { expect } from 'bun:test'
import { createLedger } from '../ledger/ledger'
import { execInsert } from '../ledger/ledgerCore'
import { openLedgerDb } from '../ledger/migration'
import { contentHash } from './memoryConsolidate'
import { insertMemoryRow, type NewMemoryRow } from './memoryInsert'

export const T0 = 1_700_000_000_000
// test-only: a credential-shaped string that redactSecrets must never let through.
export const CANARY = 'sk-CANARY0123456789abcdefghij'

export function fixture(): Database {
  const db = openLedgerDb(':memory:')
  const ledger = createLedger(db, { now: T0 })
  ledger.project.createProject({ id: 'p1', workspaceId: 'w1', name: 'Alpha', path: '/tmp/a' })
  ledger.project.createProject({ id: 'p2', workspaceId: 'w2', name: 'Beta', path: '/tmp/b' })
  return db
}

let seq = 0
/** Adds a message to a conversation (text part) with the given role. */
export function addMessage(db: Database, conversationId: string, role: string, text: string): string {
  seq += 1
  const id = `msg-${seq}`
  execInsert(
    db,
    `INSERT INTO central_message (id, conversation_id, seq, role, parts_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id, conversationId, seq, role, JSON.stringify([{ type: 'text', text }]), T0
  )
  return id
}

/** Inserts a v7 memory row directly (bypasses write-time rules, to seed hostile or odd data). */
export function seedRow(db: Database, over: Partial<NewMemoryRow> & Pick<NewMemoryRow, 'key' | 'body'>): string {
  seq += 1
  const row: NewMemoryRow = {
    id: `mem-${seq}`, projectId: null, scope: 'global', title: over.key, status: 'fact', kind: 'fact', trust: 'human',
    sourceKind: 'test', sourceRef: 'test', supersedes: null, contentHash: contentHash(over.key, over.body),
    staleAfter: null, verifiedAt: T0, now: T0, ...over,
  }
  insertMemoryRow(db, row)
  return row.id
}

/** Deep structural equality via JSON (the bun:test typings shim only offers toBe/toContain). */
export function same(actual: unknown, expected: unknown): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
}

function pickLike(actual: unknown, shape: unknown): unknown {
  if (shape === null || typeof shape !== 'object' || Array.isArray(shape) || actual === null || typeof actual !== 'object') return actual
  return Object.fromEntries(Object.keys(shape).map((k) => [k, pickLike((actual as Record<string, unknown>)[k], (shape as Record<string, unknown>)[k])]))
}

/** `actual` contains every field of `expected` (recursively), like toMatchObject. */
export function subset(actual: unknown, expected: unknown): void {
  same(pickLike(actual, expected), expected)
}

/** Message of the error `fn` throws, or '' when it does not throw. */
export function thrown(fn: () => unknown): string {
  try { fn() } catch (err) { return err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err) }
  return ''
}

/** Same as `thrown` for a promise-returning function. */
export async function rejected(fn: () => Promise<unknown>): Promise<string> {
  try { await fn() } catch (err) { return err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err) }
  return ''
}
