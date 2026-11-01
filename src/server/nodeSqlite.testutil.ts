// Vitest-only bridge: `bun:sqlite` does not exist under node, but the route modules are typed
// against it. `node:sqlite` has the same prepare/get/all/run surface, so a thin adapter lets the
// REAL inbox/memory/plan code run against an in-memory database in node-env tests.
import { DatabaseSync } from 'node:sqlite'
import type { Database } from 'bun:sqlite'

type Bind = null | number | bigint | string | Uint8Array

export function nodeSqlite(): { db: Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:')
  const bind = (params: unknown[]): Bind[] => params as Bind[]
  const db = {
    query(sql: string) {
      const statement = raw.prepare(sql)
      return {
        get: (...params: unknown[]) =>
          (statement.get(...bind(params)) as Record<string, unknown> | undefined) ?? null,
        all: (...params: unknown[]) => statement.all(...bind(params)) as Record<string, unknown>[],
        run: (...params: unknown[]) => {
          const result = statement.run(...bind(params)) as {
            changes: number | bigint
            lastInsertRowid: number | bigint
          }
          return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
        },
      }
    },
    exec(sql: string) {
      raw.exec(sql)
    },
  }
  return { db: db as unknown as Database, raw }
}
