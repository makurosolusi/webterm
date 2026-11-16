// Bun-only. Policy ("no silent tool") and the exec path: replay, refusal and a failing emitter around the real `execToolReceipt`.
import { afterEach, expect, test } from 'bun:test'
import type { ActMsg } from '../../../shared/protocol'
import { ALLOW_ALL_GUARD, execToolReceipt } from './toolExec'
import { freshDb, T0 } from '../guard/controlGuard.testutil'
import { CORE_DEFS } from './defs/core.defs'
import { ACT_COALESCE_MS, ACT_TOOLS, NO_ACT, registerActBroadcast, resetActCoalescer } from './toolAct'
import { registerCa2Tools } from './registerAll'
import { createMemoryReceiptLog } from '../../capability/capability.receipt'
import { createRegistry } from './toolRegistry'
import type { Tier, ToolCtx, ToolDef } from './toolTypes'

const stub = {} as never // test-only: builders capture deps, they never call them at registration
const env = new Proxy({} as Record<string, string>, { get: (_t, k: string) => (k === 'WEBTERM_CENTRAL_AGENTS' ? 'auto' : 'on') })

test('policy: every registered tool above R0 is announced (ACT_TOOLS) or named in NO_ACT with a reason', () => {
  const registry = createRegistry()
  for (const def of CORE_DEFS) registry.register(def)
  registerCa2Tools(registry, { executor: stub, deliver: stub, openKb: stub, skills: stub, userStore: stub, bots: stub, browser: { open: stub } as never }, env)
  const names = registry.list().map((d) => d.name)
  const silent = registry.list().filter((d) => d.tier !== 'R0' && !(d.name in ACT_TOOLS) && !NO_ACT[d.name]).map((d) => d.name)
  expect(silent).toEqual([])
  // Both tables name only real tools and never the same one, and every reason is a sentence, not a placeholder.
  expect(Object.keys(ACT_TOOLS).filter((n) => !names.includes(n))).toEqual([])
  expect(Object.keys(NO_ACT).filter((n) => !names.includes(n) || n in ACT_TOOLS)).toEqual([])
  expect(Object.values(NO_ACT).filter((r) => r.length < 15)).toEqual([])
})

function setup(maxTier: Tier = 'R3') {
  const db = freshDb()
  const registry = createRegistry()
  let runs = 0
  const def: ToolDef = {
    name: 'canvas.type', summary: 'x', tier: 'R2', usage: '{}', projectScoped: false, validate: () => null,
    handler: () => { runs++; return { ok: true, data: { nodeId: 'n1', text: 'secret typed text' } } },
  }
  registry.register(def)
  registry.register({ ...def, name: 'chat.send', handler: () => ({ ok: false, code: 'node_busy', data: { nodeId: 'n1' } }) })
  const ctx: ToolCtx = { db, registry, guard: ALLOW_ALL_GUARD, maxTier, conversationId: 'central:project:p1', now: () => T0 }
  const frames: ActMsg[] = []
  registerActBroadcast((m) => { frames.push(m) })
  return { ctx, frames, runs: () => runs, log: createMemoryReceiptLog() }
}
const settle = () => new Promise((r) => setTimeout(r, ACT_COALESCE_MS + 150))
afterEach(() => { resetActCoalescer(); registerActBroadcast(() => {}) })

test('a successful tool call announces once; replaying the same operationId does not announce again', async () => {
  const { ctx, frames, runs, log } = setup()
  const opts = { operationId: 'op-1', log }
  expect((await execToolReceipt(ctx, 'canvas.type', {}, opts)).receipt.outcome).toBe('ok')
  expect((await execToolReceipt(ctx, 'canvas.type', {}, opts)).receipt.outcome).toBe('ok')
  await settle()
  expect(runs()).toBe(1)
  expect(frames).toHaveLength(1)
  expect(frames[0]).toMatchObject({ verb: 'typed', nodeId: 'n1', n: 1 })
  expect(JSON.stringify(frames)).not.toContain('secret typed text')
})

test('a denied or failed tool call announces nothing', async () => {
  const { ctx, frames } = setup('R1')
  expect((await execToolReceipt(ctx, 'canvas.type', {})).receipt.outcome).toBe('denied')
  expect((await execToolReceipt({ ...ctx, maxTier: 'R3' }, 'chat.send', {})).receipt.outcome).toBe('error')
  await settle()
  expect(frames).toEqual([])
})

test('an emitter that throws never fails the tool', async () => {
  const { ctx } = setup()
  registerActBroadcast(() => { throw new Error('socket closed') })
  expect((await execToolReceipt(ctx, 'canvas.type', {})).receipt.outcome).toBe('ok')
  await settle() // the trailing flush runs the throwing broadcaster; the process must survive it
})
