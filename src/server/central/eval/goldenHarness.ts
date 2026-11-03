// Golden harness (RND/29-b §4.13): a real file-backed ledger + TurnService driven by a
// ScriptedRuntime. Time is virtual (no sleeping), ports are OS-assigned, and `restart()`
// reopens the database file the way a process reboot would. Bun-only (bun:sqlite).
//
// TODO(ca2-16b): golden tests still to write once their workstreams land (RND/29-b §4.13):
//   G1  happy path chat -> proposal -> approval -> worker -> verified (needs WS-09/10 + WS-19 wiring)
//   G4  crash during spawn leaves no orphan worker/task (needs WS-09 agent.* state machine)
//   G5  long conversation keeps context within budget (needs WS-06 assembler + WS-08 memory)
//   G6  >=20 injection payloads, canary secret = 0 (extend adversarialPayloads.ts; needs WS-05/07)
//   G8  provider breaker opens on 429/auth/quota and backs off (needs WS-07 breaker)
//   G9  POST /api/central/halt stops all effects (needs WS-07 kill-switch + WS-19 route)
//   G10 memory survives a model/runtime swap (needs WS-08)
//   G11 invalid/group approval is refused (needs WS-12 channel + approval gate wiring)
//   G12 audit hash chain verifies and detects tampering (needs ledger v9, WS-18)
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow } from '../../ledger/ledgerCore'
import { openLedgerDb } from '../../ledger/migration'
import { StreamHub } from '../chat/streamHub'
import { reconcileTurns, type ReconcileResult } from '../chat/turnReconciler'
import { TurnService } from '../chat/turnService'
import { listConversationEvents } from '../conversationStore'
import type { ControlGuard } from '../tools/toolTypes'
import { createVirtualClock, ScriptedRuntime, type ScriptClock, type ScriptedTurn } from './scriptedRuntime'

/** Fixed virtual start; value is arbitrary but non-zero so ordering bugs show up. */
export const GOLDEN_START_MS = 1_700_000_000_000 // test-only
export const GOLDEN_PROJECT = 'p1' // test-only
export const GOLDEN_CONVERSATION = 'central:global'

export interface HarnessOptions {
  turns: readonly ScriptedTurn[]
  /** Per-turn limit env (e.g. `WEBTERM_CENTRAL_TURN_TOKENS`); defaults to none. */
  limitEnv?: NodeJS.ProcessEnv
  /** Enables planner + write tools so proposals are applied; default true. */
  proposals?: boolean
}

export interface GoldenHarness {
  clock: ScriptClock
  /** OS-assigned free TCP port, for tests that need to boot a listener. */
  port: number
  db: Database
  service: TurnService
  runtime: ScriptedRuntime
  /** Simulates a crash + reboot: drops the process state, reopens the DB file, reconciles. */
  restart(turns: readonly ScriptedTurn[]): ReconcileResult
  count(sql: string, ...params: unknown[]): number
  /** True when `needle` occurs in any column of any table (secret-canary scan). */
  dbContains(needle: string): boolean
  cleanup(): void
}

/** Asks the OS for a free TCP port by binding port 0, then releases it. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (err) => reject(new Error(`freePort: cannot bind an ephemeral port: ${err.message}`)))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('freePort: no port assigned'))))
    })
  })
}

/** Daily caps from the approved product decision P11 (1M tokens/day, 20 spawns/day). */
export const DAILY_TOKEN_LIMIT = 1_000_000
export const DAILY_SPAWN_LIMIT = 20

const DAY_CHARS = 10 // 'YYYY-MM-DD' prefix of an ISO timestamp (UTC), the `central_budget.day` key
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, DAY_CHARS)

/** Seeds today's global budget row, replacing any previous one. */
export function setDailyUsage(db: Database, clock: ScriptClock, usage: { tokens: number; spawns: number }): void {
  execWrite(
    db, `INSERT OR REPLACE INTO central_budget (day, scope, tokens, spawns) VALUES (?, 'global', ?, ?)`,
    dayOf(clock.now()), usage.tokens, usage.spawns
  )
}

/**
 * Stand-in for the WS-07 ControlGuard budget check: denies with `budget_exhausted` once today's
 * `central_budget` row reaches a cap. TODO(ca2-16b): replace with the real guard when WS-07 lands.
 */
export function createBudgetGuard(db: Database, clock: ScriptClock, spawnTools: readonly string[]): ControlGuard {
  return {
    check(request) {
      const row = getRow(db, `SELECT tokens, spawns FROM central_budget WHERE day = ? AND scope = 'global'`, dayOf(clock.now()))
      const overTokens = Number(row?.['tokens'] ?? 0) >= DAILY_TOKEN_LIMIT
      const overSpawns = spawnTools.includes(request.tool) && Number(row?.['spawns'] ?? 0) >= DAILY_SPAWN_LIMIT
      return overTokens || overSpawns ? { ok: false, code: 'budget_exhausted' } : { ok: true }
    },
  }
}

function closeDb(db: Database): void {
  ;(db as unknown as { close(): void }).close()
}

const PROPOSAL_FLAGS = ['WEBTERM_CENTRAL_PLANNER', 'WEBTERM_CENTRAL_TOOLS'] as const

/** Builds a harness; the caller must run `cleanup()` (restores env flags, removes the temp dir). */
export async function createHarness(options: HarnessOptions): Promise<GoldenHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'webterm-golden-'))
  const dbPath = join(dir, 'ledger.db')
  const clock = createVirtualClock(GOLDEN_START_MS)
  const saved = new Map<string, string | undefined>(PROPOSAL_FLAGS.map((flag) => [flag, process.env[flag]]))
  if (options.proposals ?? true) {
    process.env.WEBTERM_CENTRAL_PLANNER = 'on'
    process.env.WEBTERM_CENTRAL_TOOLS = 'write'
  }
  const port = await freePort()

  function boot(turns: readonly ScriptedTurn[]): { db: Database; runtime: ScriptedRuntime; service: TurnService } {
    const db = openLedgerDb(dbPath)
    const runtime = new ScriptedRuntime({ turns, clock })
    const stream = new StreamHub({ replay: (id, after) => listConversationEvents(db, id, after, 500), heartbeatMs: 0 })
    const service = new TurnService({ db, runtime, stream, now: clock.now, env: options.limitEnv ?? {} })
    return { db, runtime, service }
  }

  const first = boot(options.turns)
  execWrite(
    first.db,
    `INSERT OR IGNORE INTO project (id, workspace_id, name, path, status, priority, created_at, updated_at)
     VALUES (?, 'w-p1', 'Alpha', '/tmp/p1', 'active', 5, ?, ?)`,
    GOLDEN_PROJECT, clock.now(), clock.now()
  )

  const harness: GoldenHarness = {
    clock, port, db: first.db, service: first.service, runtime: first.runtime,
    restart(turns) {
      closeDb(harness.db)
      const next = boot(turns)
      Object.assign(harness, { db: next.db, service: next.service, runtime: next.runtime })
      return reconcileTurns(next.db, clock.now())
    },
    count: (sql, ...params) => Number(getRow(harness.db, sql, ...params)?.['c'] ?? -1),
    dbContains(needle) {
      const tables = allRows(harness.db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      return tables.some((table) =>
        allRows(harness.db, `SELECT * FROM "${String(table['name'])}"`).some((row) => JSON.stringify(row).includes(needle)))
    },
    cleanup() {
      closeDb(harness.db)
      for (const [flag, value] of saved) {
        if (value === undefined) delete process.env[flag]
        else process.env[flag] = value
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return harness
}
