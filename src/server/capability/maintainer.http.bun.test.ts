// Bun-only: the maintainer diagnosis capabilities over `/api/tools` with the REAL ledger policy, real node tokens and the
// live wiring (temp data dir): a plain node is refused, a node stored with the maintainer preset is answered, and a
// secret in the environment never appears in any answer.
import { afterAll, afterEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Workspace, WsNode } from '../../shared/workspace'
import { createSeenStore } from '../cli/cli.seen'
import { resetEventsRuntimeForTest } from '../events/eventsRuntime'
import { NODE_TOKEN_HEADER, nodeToken, resetNodeTokenMemoryForTest } from '../hooksTokens'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import { resetActiveLedgerRuntimeForTest, setActiveLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { openLedgerDb } from '../ledger/migration'
import { resetActivePolicyForTest } from '../policy/policy.runtime'
import { chatCapabilityBriefing, chatCapabilityProfile } from '../agentChat/agentChat.capabilities'
import { MAINTAINER_RULE } from '../../shared/agentCapabilities'
import { toolsRoute, type ToolsDeps } from './capability.http'
import { createMemoryReceiptLog } from './capability.receipt'

const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'maint-http-')))
const prevDir = process.env.WEBTERM_DATA_DIR
const prevHome = process.env.HOME
process.env.WEBTERM_DATA_DIR = join(root, 'data') // the live wiring opens the env-settings DB: never the real one
const SECRET = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_0123456' // test-only
process.env.WEBTERM_TELEGRAM_BOT_TOKEN = SECRET
afterAll(() => {
  delete process.env.WEBTERM_TELEGRAM_BOT_TOKEN
  if (prevDir === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prevDir
  if (prevHome !== undefined) process.env.HOME = prevHome
  rmSync(root, { recursive: true, force: true })
})

const node = (id: string, extra: Partial<WsNode> = {}): WsNode => ({ id, kind: 'agentChat', x: 0, y: 0, ...extra })
const BOARD: Workspace[] = [{ id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('plain'), node('maint', { preset: 'maintainer' })], bridges: [], updatedAt: 0 }]

let db: Database | null = null
let n = 0
function boot(): ToolsDeps {
  resetNodeTokenMemoryForTest()
  resetEventsRuntimeForTest()
  const path = join(root, `ledger-${n++}.db`)
  db = openLedgerDb(path)
  setActiveLedgerRuntime({ mode: 'on', path, db, ledger: {} } as unknown as LedgerRuntime)
  resetActivePolicyForTest()
  return { dispatch: async () => undefined, workspaces: () => BOARD, receipts: createMemoryReceiptLog(), seen: createSeenStore(join(root, `seen-${n}`)) }
}
afterEach(() => {
  if (db) (db as unknown as { close(): void }).close()
  db = null
  resetActivePolicyForTest()
  resetEventsRuntimeForTest()
  resetActiveLedgerRuntimeForTest()
  resetNodeTokenMemoryForTest()
})

async function call(deps: ToolsDeps, method: string, path: string, token: string, body?: unknown) {
  const server = createServer((req, res) => { void toolsRoute(req, res, new URL(req.url ?? '/', 'http://x'), deps) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method, headers: { [NODE_TOKEN_HEADER]: token }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const text = await res.text()
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> }
  } finally {
    server.close()
  }
}

test('a plain node is refused and does not see them as allowed; a maintainer node does, with the rule in agent-context', async () => {
  const deps = boot()
  const refused = await call(deps, 'POST', '/api/tools/instance.info', nodeToken('plain'), {})
  expect(refused.status).toBe(403)
  expect(refused.text).toContain('not_maintainer')
  type Ctx = { rule?: string; capabilities: { name: string; allowed: boolean }[] }
  const names = (c: Ctx) => c.capabilities.filter((x) => x.allowed).map((x) => x.name)
  const plain = (await call(deps, 'GET', '/api/tools', nodeToken('plain'))).body as unknown as Ctx
  expect(names(plain)).not.toContain('doctor.run')
  expect(plain.rule).toBe(undefined)
  const maint = (await call(deps, 'GET', '/api/tools', nodeToken('maint'))).body as unknown as Ctx
  expect(names(maint)).toEqual(expect.arrayContaining(['doctor.run', 'config.read', 'instance.info', 'logs.query', 'logs.summary']))
  expect(maint.rule).toContain('Never tell the user to run a shell command or send a screenshot')
})

test('instance.info and config.read answer a maintainer node and never return the secret', async () => {
  const deps = boot()
  const info = await call(deps, 'POST', '/api/tools/instance.info', nodeToken('maint'), {})
  expect(info.status).toBe(200)
  expect((info.body.data as Record<string, unknown>).nodes).toBe(2)
  const cfg = await call(deps, 'POST', '/api/tools/config.read', nodeToken('maint'), { q: 'TELEGRAM' })
  expect(cfg.status).toBe(200)
  expect(cfg.text).not.toContain(SECRET)
  expect(cfg.text).toContain('WEBTERM_TELEGRAM_BOT_TOKEN') // the row is there, its value is not
})

test('a chat node with the maintainer preset gets the maintainer briefing (rule once); a plain chat does not', () => {
  expect(chatCapabilityProfile('maintainer')).toBe('chat.maintainer')
  const b = chatCapabilityBriefing('maintainer', { ...process.env, WEBTERM_BROWSER: 'on' }) ?? ''
  expect(b).toContain(MAINTAINER_RULE)
  expect(b.split(MAINTAINER_RULE).length).toBe(2)
  expect(chatCapabilityBriefing(undefined, { ...process.env, WEBTERM_BROWSER: 'on' })).not.toContain(MAINTAINER_RULE)
})
