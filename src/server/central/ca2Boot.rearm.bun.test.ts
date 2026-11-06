import { afterEach, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import type { CapabilityId } from '../../shared/featureCapabilities'
import { reconcile } from '../featureCapabilities.runtime'
import { bootCa2, setActiveCa2 } from './ca2Boot'
import { TurnService } from './chat/turnService'
import { StreamHub } from './chat/streamHub'
import { getTurn } from './conversationStore'
import { freshDb, rows } from './guard/controlGuard.testutil'
import { MockRuntime } from './runtime/mockRuntime'
import { CORE_DEFS } from './tools/defs/core.defs'
import { createRegistry } from './tools/toolRegistry'

const sessions = { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike
const dirs: string[] = []
afterEach(() => { setActiveCa2(null); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const CENTRAL = new Set<CapabilityId>(['central'])
const NONE = new Set<CapabilityId>()

it('Central off -> on mid-turn keeps the live turn: it succeeds with its full answer, never interrupted', async () => {
  const db = freshDb()
  const registry = createRegistry()
  for (const d of CORE_DEFS) registry.register(d)
  const dir = mkdtempSync(join(tmpdir(), 'ca2-rearm-'))
  dirs.push(dir)
  const env: Record<string, string | undefined> = { WEBTERM_CENTRAL: 'on' }
  const handle = bootCa2({ runtime: { db } as unknown as LedgerRuntime, sessions, env, registry, dataDirPath: dir, noTimer: true })
  await reconcile(NONE, CENTRAL) // boot-time capability reconcile marks the hook running
  await handle?.ready
  const svc = new TurnService({ db, runtime: new MockRuntime({ chunks: ['a', 'b', 'c', 'd'], stepDelayMs: 40 }), stream: new StreamHub() })
  const r = svc.submit({ conversationId: 'central:global', clientMessageId: 'c1', text: 'hello' })
  await new Promise((res) => setTimeout(res, 60))
  env.WEBTERM_CENTRAL = 'off'
  await reconcile(CENTRAL, NONE)
  env.WEBTERM_CENTRAL = 'on'
  await reconcile(NONE, CENTRAL)
  await handle?.ready
  const done = await r.done
  expect(done.status).toBe('succeeded')
  expect(getTurn(db, r.response.turnId)?.errorCode ?? null).toBeNull()
  const msg = rows(db, "SELECT parts_json FROM central_message WHERE turn_id = ? AND role = 'assistant'", r.response.turnId)[0]
  expect(String(msg?.parts_json)).toContain('abcd')
  handle?.stop()
})
