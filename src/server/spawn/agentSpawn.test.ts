import { afterEach, describe, expect, it } from 'vitest'
import type { ExecHandle, ExecOutcome, ExecSpec } from '../central/agents/execRunner'
import { eventBus } from '../events/eventBus'
import type { SenseEvent } from '../events/eventModel'
import { harness, spawnBody } from '../control/fakeControlDeps'
import { CapabilityStore, allows } from '../control/capabilities'
import { claudeHeadlessArgv, createAgentSpawner, resetAgentSpawnerForTest, type AgentSpawnerOptions, type AgentSpawnRequest } from './agentSpawn'

// test-only fakes: lineage in a map, events in an array, PTY exits fired by hand.
function rig(opts: AgentSpawnerOptions = {}) {
  const lineage = new Map<string, string>()
  const events: { kind: string; actor?: string; subject?: string | null; payload: unknown }[] = []
  let fireExit: (nodeId: string, code: number | null) => void = () => {}
  const spawner = createAgentSpawner({
    ancestors: (p) => { const out: string[] = []; for (let c = lineage.get(p); c; c = lineage.get(c)) out.push(c); return out },
    registerSpawn: (parent, child) => { lineage.set(child, parent) },
    record: (e) => { events.push({ kind: e.kind, actor: e.actor, subject: e.subject, payload: e.payload }) },
    onPtyExit: (fn) => { fireExit = fn },
    ...opts,
  })
  const opened: string[] = []
  const io = { openPty: (o: { nodeId: string }) => { opened.push(o.nodeId) } }
  const pty = (parent: string, nodeId: string, extra: Partial<AgentSpawnRequest> = {}) => spawner.spawn({ door: 'control', mode: 'pty', parent, nodeId, ...extra }, io)
  return { spawner, lineage, events, opened, io, pty, exit: (n: string) => fireExit(n, 0) }
}

describe('agent.spawn nesting depth (Orca NESTED_WORKER_MAX_DEPTH)', () => {
  it('root -> depth 1 -> depth 2 is allowed, depth 3 is refused with nothing opened', async () => {
    const r = rig()
    expect(await r.pty('central', 'a')).toMatchObject({ ok: true, childId: 'node:a', depth: 1 })
    expect(await r.pty('node:a', 'b')).toMatchObject({ ok: true, depth: 2 })
    const deep = await r.pty('node:b', 'c')
    expect(deep).toMatchObject({ ok: false, code: 'spawn_depth_exceeded' })
    expect(r.opened).toEqual(['a', 'b'])
    expect(r.lineage.has('node:c')).toBe(false)
  })

  it('reads persisted lineage for a node it did not spawn; an unrecorded node counts as depth 1', async () => {
    const r = rig()
    r.lineage.set('node:old', 'node:top') // node:top has no record: a hand-opened canvas node (depth 1)
    expect(r.spawner.depthOf('node:top')).toBe(1)
    expect(r.spawner.depthOf('node:old')).toBe(2)
    expect(await r.pty('node:old', 'x')).toMatchObject({ ok: false, code: 'spawn_depth_exceeded' })
    expect(await r.pty('node:top', 'y')).toMatchObject({ ok: true, depth: 2 })
  })

  it('honours a configured max depth', async () => {
    const r = rig({ maxDepth: 1 })
    expect(await r.pty('human-ui', 'a')).toMatchObject({ ok: true })
    expect(await r.pty('node:a', 'b')).toMatchObject({ ok: false, code: 'spawn_depth_exceeded' })
  })
})

describe('agent.spawn per-parent cap', () => {
  it('a node runs at most maxChildren live children; an exit frees a slot and emits agent.exit', async () => {
    const r = rig({ maxChildren: 2 })
    await r.pty('central', 'p')
    expect((await r.pty('node:p', 'c1')).ok).toBe(true)
    expect((await r.pty('node:p', 'c2')).ok).toBe(true)
    expect(await r.pty('node:p', 'c3')).toMatchObject({ ok: false, code: 'spawn_cap_exceeded' })
    r.exit('c1')
    expect(r.events.filter((e) => e.kind === 'agent.exit')).toEqual([{ kind: 'agent.exit', actor: 'node:c1', subject: 'node:c1', payload: { parent: 'node:p', code: 0, reason: 'pty_exit' } }])
    expect((await r.pty('node:p', 'c3')).ok).toBe(true)
    expect(r.spawner.childrenOf('node:p')).toEqual(['node:c2', 'node:c3'])
  })

  it('concurrent spawns of one parent never pass the cap (slot reserved before the open awaits)', async () => {
    const r = rig({ maxChildren: 2 })
    await r.pty('central', 'p')
    const slowIo = { openPty: async () => { await new Promise((res) => setTimeout(res, 5)) } }
    const all = await Promise.all([1, 2, 3, 4].map((n) => r.spawner.spawn({ door: 'control', mode: 'pty', parent: 'node:p', nodeId: `k${n}` }, slowIo)))
    expect(all.filter((x) => x.ok)).toHaveLength(2)
  })

  it('root principals are not capped here (Central keeps its own per-project caps)', async () => {
    const r = rig({ maxChildren: 1 })
    for (const n of ['a', 'b', 'c']) expect((await r.pty('human-ui', n)).ok).toBe(true)
  })

  it('a failed open releases the slot, registers no lineage and rethrows', async () => {
    const r = rig({ maxChildren: 1 })
    await r.pty('central', 'p')
    const boom = { openPty: () => { throw new Error('pty down') } }
    await expect(r.spawner.spawn({ door: 'control', mode: 'pty', parent: 'node:p', nodeId: 'x' }, boom)).rejects.toThrow('pty down')
    expect(r.lineage.has('node:x')).toBe(false)
    expect((await r.pty('node:p', 'y')).ok).toBe(true)
  })
})

describe('agent.spawn lineage, events and names', () => {
  it('registers lineage and appends one agent.spawn event without the prompt', async () => {
    const r = rig()
    const inputs: string[] = []
    const res = await r.spawner.spawn({ door: 'orchestrator', mode: 'pty', parent: 'central', nodeId: 'w1', workspaceId: 'ws1', prompt: 'secret task', title: 'Fix login' }, { ...r.io, input: (_n, t) => { inputs.push(t) } })
    expect(res).toMatchObject({ ok: true, name: 'Fix login' })
    expect(r.lineage.get('node:w1')).toBe('central')
    expect(inputs).toEqual(['secret task\r'])
    expect(r.events).toEqual([{ kind: 'agent.spawn', actor: 'central', subject: 'node:w1', payload: { kind: 'claude', mode: 'pty', door: 'orchestrator', depth: 1, name: 'Fix login' } }])
    expect(JSON.stringify(r.events)).not.toContain('secret')
  })

  it('makes display names unique among live agents', async () => {
    const r = rig()
    const names = []
    for (const n of ['a', 'b', 'c']) { const x = await r.pty('central', n, { title: 'Reviewer' }); names.push(x.ok ? x.name : x.code) }
    expect(names).toEqual(['Reviewer', 'Reviewer (2)', 'Reviewer (3)'])
  })

  it('refuses a malformed request at the boundary', async () => {
    const r = rig()
    expect(await r.spawner.spawn({ door: 'control', mode: 'pty', parent: 'central' }, r.io)).toMatchObject({ ok: false, code: 'spawn_invalid' })
    expect(await r.spawner.spawn({ door: 'control', mode: 'bogus' as 'pty', parent: 'central', nodeId: 'n' }, r.io)).toMatchObject({ ok: false, code: 'spawn_invalid' })
    expect(await r.spawner.spawn({ door: 'central', mode: 'headless', parent: 'central', cwd: '/tmp' })).toMatchObject({ ok: false, code: 'spawn_invalid' })
    expect(r.events).toEqual([])
  })
})

describe('agent.spawn headless mode', () => {
  function fakeExec() {
    const specs: ExecSpec[] = []
    let finish: (o: ExecOutcome) => void = () => {}
    const exec = (spec: ExecSpec): ExecHandle => {
      specs.push(spec)
      return { pid: 1, done: new Promise<ExecOutcome>((res) => { finish = res }), tail: () => '', kill: () => {} }
    }
    return { specs, exec, finish: (o: ExecOutcome) => finish(o) }
  }

  it('defaults to Claude Code print mode, returns the handle and emits agent.exit when it ends', async () => {
    const fx = fakeExec()
    const r = rig({ exec: fx.exec })
    const res = await r.spawner.spawn({ door: 'central', mode: 'headless', parent: 'central', cwd: '/tmp/wt', prompt: 'do it' })
    expect(res.ok && res.handle?.pid).toBe(1)
    expect(fx.specs[0]).toMatchObject({ argv: claudeHeadlessArgv('do it'), cwd: '/tmp/wt' })
    expect(claudeHeadlessArgv('x').slice(0, 2)).toEqual(['claude', '-p'])
    const childId = res.ok ? res.childId : ''
    expect(r.lineage.get(childId)).toBe('central')
    fx.finish({ exitCode: 0, timedOut: false, killed: false, lastEvent: null, tail: '' })
    await new Promise((res2) => setTimeout(res2, 0))
    expect(r.events.map((e) => e.kind)).toEqual(['agent.spawn', 'agent.exit'])
    expect(r.spawner.childrenOf('central')).toEqual([])
  })

  it('uses the door argv when given (custom headless kinds)', async () => {
    const fx = fakeExec()
    const r = rig({ exec: fx.exec })
    await r.spawner.spawn({ door: 'central', mode: 'headless', kind: 'opencode', parent: 'central', cwd: '/tmp/wt', nodeId: 'c-ag-1', headless: { argv: ['opencode', 'run', 'x'], timeoutMs: 5 } })
    expect(fx.specs[0]).toMatchObject({ argv: ['opencode', 'run', 'x'], timeoutMs: 5 })
    expect(r.events[0]).toMatchObject({ subject: 'node:c-ag-1', payload: { kind: 'opencode', mode: 'headless' } })
  })
})

describe('control door routes through agent.spawn', () => {
  afterEach(() => resetAgentSpawnerForTest())

  it('a control spawn appends agent.spawn with door control (shared spawner, real bus)', async () => {
    resetAgentSpawnerForTest()
    const seen: SenseEvent[] = []
    const off = eventBus.subscribe('agent.spawn', (e) => { seen.push(e) })
    const h = harness()
    const res = await h.call('POST', 'spawn', spawnBody('req-0001', 'node-a'), { 'x-webterm-capability': h.token('node.spawn', 'node:node-a') })
    off()
    expect(res?.status).toBe(201)
    expect(h.opened.map((m) => m.id)).toEqual(['node-a'])
    expect(seen.map((e) => [e.subject, (e.payload as { door: string }).door])).toEqual([['node:node-a', 'control']])
  })

  it('a node at max depth spawning through the control API gets 403 spawn_depth_exceeded', async () => {
    const r = rig()
    resetAgentSpawnerForTest(r.spawner)
    await r.pty('central', 'top')
    await r.pty('node:top', 'mid') // depth 2
    const store = new CapabilityStore()
    const token = store.mint({ verb: 'node.spawn', resource: 'node:deep', mintedBy: 'node:mid' })
    const h = harness({ capabilities: { verify: (t) => store.verify(t), allows } })
    const res = await h.call('POST', 'spawn', spawnBody('req-0002', 'deep'), { 'x-webterm-capability': token })
    expect(res).toMatchObject({ status: 403, body: { error: 'spawn_depth_exceeded' } })
    expect(h.opened).toEqual([])
  })
})
