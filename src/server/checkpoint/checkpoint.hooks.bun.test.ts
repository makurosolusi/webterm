// The two Central call sites, end to end on a temp git repo: an R1 tool run through `execTool`
// checkpoints first (R0 does not, a denied call does not), and POST /api/central/halt takes a panic
// snapshot next to the kill.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import npath from 'node:path'
import { promisify } from 'node:util'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import { bootCa2, setActiveCa2 } from '../central/ca2Boot'
import { ca2Dispatch } from '../central/ca2Routes'
import { createControlGuard, toToolGuard } from '../central/guard/controlGuard'
import { freshDb, HUMAN, T0 } from '../central/guard/controlGuard.testutil'
import { setLevel } from '../central/guard/levelStore'
import { CORE_DEFS } from '../central/tools/defs/core.defs'
import { execTool } from '../central/tools/toolExec'
import { createRegistry } from '../central/tools/toolRegistry'
import type { Tier, ToolCtx } from '../central/tools/toolTypes'
import { registerWorkspaceLookup } from '../central/workspaceLookup'
import { listWorkspaceCheckpoints } from './checkpoint.service'

const run = promisify(execFile)
const T = 30_000
const GIT_ENV = { // test-only identity, isolated from the user's git config
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'webterm test', GIT_AUTHOR_EMAIL: 't@webterm.test', GIT_COMMITTER_NAME: 'webterm test', GIT_COMMITTER_EMAIL: 't@webterm.test',
}
const g = (cwd: string, ...args: string[]) => run('git', args, { cwd, env: GIT_ENV })
const sessions = { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike

let dir = ''
let unregister = () => {}
const ws = () => ({ id: 'w1', cwd: dir }) // freshDb maps project p1 -> workspace w1
const reasons = async () => { const l = await listWorkspaceCheckpoints(ws()); return l.rewindable ? l.checkpoints.map((c) => c.reason) : null }

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(npath.join(tmpdir(), 'webterm-ckpt-hooks-')))
  await g(dir, 'init', '-q', '-b', 'main')
  await fs.writeFile(npath.join(dir, 'a.txt'), 'one\n')
  const rec = { id: 'w1', name: 'One', cwd: dir, nodes: [] }
  unregister = registerWorkspaceLookup((id) => (id === 'w1' ? rec : null), () => [rec])
})
afterEach(async () => {
  unregister()
  await fs.rm(dir, { recursive: true, force: true })
})

test('execTool: R1 effect checkpoints before its handler; R0 and denied calls do not', async () => {
  const db = freshDb()
  setLevel(db, { scope: 'global', level: 'act_gated', actor: HUMAN, now: () => T0 })
  const guard = createControlGuard({ db, now: () => T0, env: { WEBTERM_CENTRAL_AGENTS: 'propose' }, random: () => 0 })
  const registry = createRegistry()
  const seen: Array<string[] | null> = []
  for (const tier of ['R0', 'R1', 'R2'] as Tier[]) {
    registry.register({ name: `t.${tier.toLowerCase()}`, summary: tier, tier, usage: '{}', validate: () => null, handler: async () => { seen.push(await reasons()); return { ok: true } } })
  }
  const ctx: ToolCtx = { db, registry, guard: toToolGuard(guard), maxTier: 'R3', conversationId: 'central:project:p1', now: () => T0 }
  expect((await execTool(ctx, 't.r0', { projectId: 'p1' })).ok).toBe(true)
  expect((await execTool(ctx, 't.r1', { projectId: 'p1' })).ok).toBe(true)
  expect((await execTool(ctx, 't.r2', { projectId: 'p1' })).code).toBe('approval_required')
  expect(seen).toEqual([[], ['action']]) // the R1 handler already saw its checkpoint
  expect(await reasons()).toEqual(['action'])
}, T)

test('halt takes a panic snapshot of registered workspaces', async () => {
  const data = await fs.mkdtemp(npath.join(tmpdir(), 'webterm-ckpt-ca2-'))
  const registry = createRegistry()
  for (const d of CORE_DEFS) registry.register(d)
  const h = bootCa2({ runtime: { db: freshDb() } as unknown as LedgerRuntime, sessions, registry, noTimer: true, dataDirPath: data, now: () => T0, env: { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_AGENTS: 'propose' } })
  if (!h) throw new Error('boot failed')
  try {
    const res = await ca2Dispatch(h, { method: 'POST', path: '/api/central/halt', query: new URLSearchParams(), body: async () => ({ reason: 'test' }) })
    expect(res).toMatchObject({ status: 200, body: { halted: true } })
    expect(await reasons()).toEqual(['halt'])
  } finally {
    h.stop()
    setActiveCa2(null)
    await fs.rm(data, { recursive: true, force: true })
  }
}, T)
