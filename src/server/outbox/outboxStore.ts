// Persistent per-node outbox over the ledger `agent_outbox` table (schema v12). Imitates Orca's
// durable mailbox (`src/main/runtime/orchestration/db-undelivered-mailboxes.test.ts`,
// `mailbox-pointer-eligibility.ts:61-91` `selectOrchestrationPointerBatch`): mail is a row first and
// a PTY write second, so a busy agent or a restart never loses it. The DB handle is injected; this
// module imports bun:sqlite types only.
import type { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow, newId, type Row } from '../ledger/ledgerCore'

export type OutboxKind = 'visible' | 'context'
export type OutboxStatus = 'queued' | 'delivered' | 'failed' | 'cancelled'
export type OutboxTransport = 'channel' | 'hook' | 'pty'

export interface OutboxMessage {
  id: string
  operationId: string
  to: string
  kind: OutboxKind
  body: string
  priority: number
  status: OutboxStatus
  transport: OutboxTransport | null
  error: string | null
  createdBy: string
  createdAt: number
  settledAt: number | null
}

export interface EnqueueInput {
  to: string
  body: string
  kind: OutboxKind
  operationId: string
  priority?: number
  createdBy: string
}

/** Same batch cap idea as Orca `ORCHESTRATION_DELIVERY_BATCH_LIMIT`: one delivery, bounded size. */
export const OUTBOX_BATCH_LIMIT = 10
export const OUTBOX_LIST_MAX = 200

const COLS = 'id, operation_id, to_node, kind, body, priority, status, transport, error, created_by, created_at, settled_at'

function toMessage(r: Row): OutboxMessage {
  return {
    id: String(r['id']),
    operationId: String(r['operation_id']),
    to: String(r['to_node']),
    kind: r['kind'] as OutboxKind,
    body: String(r['body']),
    priority: Number(r['priority']),
    status: r['status'] as OutboxStatus,
    transport: (r['transport'] as OutboxTransport | null) ?? null,
    error: (r['error'] as string | null) ?? null,
    createdBy: String(r['created_by']),
    createdAt: Number(r['created_at']),
    settledAt: r['settled_at'] === null || r['settled_at'] === undefined ? null : Number(r['settled_at']),
  }
}

export function createOutboxStore(db: Database, now: () => number = Date.now) {
  const byOp = (op: string): OutboxMessage | null => {
    const r = getRow(db, `SELECT ${COLS} FROM agent_outbox WHERE operation_id = ?`, op)
    return r ? toMessage(r) : null
  }
  const settle = (ids: readonly string[], status: OutboxStatus, transport: OutboxTransport | null, error: string | null): void => {
    for (const id of ids) {
      execWrite(db, "UPDATE agent_outbox SET status = ?, transport = ?, error = ?, settled_at = ? WHERE id = ? AND status = 'queued'", status, transport, error, now(), id)
    }
  }
  return {
    /** Insert, or return the row an earlier call with the same operationId created (exactly-once). */
    enqueue(input: EnqueueInput): { message: OutboxMessage; deduped: boolean } {
      const id = newId()
      const changed = execWrite(db,
        `INSERT INTO agent_outbox (id, operation_id, to_node, kind, body, priority, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(operation_id) DO NOTHING`,
        id, input.operationId, input.to, input.kind, input.body, input.priority ?? 0, input.createdBy, now())
      const message = byOp(input.operationId)
      if (!message) throw new Error(`outbox.enqueue: row for operation ${input.operationId} missing after insert`)
      return { message, deduped: changed === 0 }
    },
    get: (id: string): OutboxMessage | null => {
      const r = getRow(db, `SELECT ${COLS} FROM agent_outbox WHERE id = ?`, id)
      return r ? toMessage(r) : null
    },
    /** Queued mail for one node, highest priority first, oldest first within a priority. */
    queued(to: string, kind?: OutboxKind): OutboxMessage[] {
      const rows = kind
        ? allRows(db, `SELECT ${COLS} FROM agent_outbox WHERE to_node = ? AND status = 'queued' AND kind = ? ORDER BY priority DESC, created_at, rowid LIMIT ?`, to, kind, OUTBOX_BATCH_LIMIT)
        : allRows(db, `SELECT ${COLS} FROM agent_outbox WHERE to_node = ? AND status = 'queued' ORDER BY priority DESC, created_at, rowid LIMIT ?`, to, OUTBOX_BATCH_LIMIT)
      return rows.map(toMessage)
    },
    /** Every node with queued mail: the redrive set after a restart. */
    queuedNodes: (): string[] => allRows(db, "SELECT DISTINCT to_node FROM agent_outbox WHERE status = 'queued'").map((r) => String(r['to_node'])),
    /** Newest first, paginated (status view for the API). */
    list(to: string, limit = 50, offset = 0): OutboxMessage[] {
      return allRows(db, `SELECT ${COLS} FROM agent_outbox WHERE to_node = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
        to, Math.min(Math.max(limit, 1), OUTBOX_LIST_MAX), Math.max(offset, 0)).map(toMessage)
    },
    markDelivered: (ids: readonly string[], transport: OutboxTransport): void => settle(ids, 'delivered', transport, null),
    markFailed: (ids: readonly string[], transport: OutboxTransport | null, error: string): void => settle(ids, 'failed', transport, error),
    markCancelled: (ids: readonly string[]): void => settle(ids, 'cancelled', null, null),
    /** Cancel queued rows of `to` whose operationId starts with `prefix`, except `keepOp`. */
    cancelQueued(to: string, prefix: string, keepOp?: string): OutboxMessage[] {
      const rows = allRows(db, `SELECT ${COLS} FROM agent_outbox WHERE to_node = ? AND status = 'queued' AND substr(operation_id, 1, ?) = ?`, to, prefix.length, prefix)
        .map(toMessage).filter((m) => m.operationId !== keepOp)
      settle(rows.map((m) => m.id), 'cancelled', null, null)
      return rows
    },
  }
}

export type OutboxStore = ReturnType<typeof createOutboxStore>
