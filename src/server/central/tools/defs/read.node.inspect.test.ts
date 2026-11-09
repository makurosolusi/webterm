import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionsCore } from '../../../sessionsCore'
import { registerWorkspaceLookup } from '../../workspaceLookup'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ToolCtx } from '../toolTypes'
import { createNodeReadDefs, type NodeReadDeps } from './read.node'
import { lastAssistantModel, type NodeSessionView } from './read.node.inspect'
import { READ_TOOLS_FLAG } from './read.shared'

/** Real registry behind the sessions (status, transcript path, exit tombstone); no PTY is ever started. */
class Probe extends SessionsCore {
  get reg() { return this.registry }
}

const ENV_KEYS = ['WEBTERM_DATA_DIR', 'HOME', 'CLAUDE_CONFIG_DIR'] as const
let saved: Record<string, string | undefined>
let dir: string
let f: Fixture
let unregister = (): void => undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'node-read-'))
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.WEBTERM_DATA_DIR = join(dir, 'data')
  process.env.HOME = join(dir, 'home')
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude')
  f = openFixture(); seedPortfolio(f.db)
})
afterEach(() => {
  unregister(); f.close()
  for (const k of ENV_KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
  rmSync(dir, { recursive: true, force: true })
})

function ctx(deps: NodeReadDeps = {}): ToolCtx {
  const registry = createRegistry()
  createNodeReadDefs(deps).forEach((d) => registry.register(d))
  return { db: f.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R0', conversationId: 'central:global', now: () => 1, env: { [READ_TOOLS_FLAG]: 'on' } }
}
/** `nodes` live in project p1's workspace (w-p1); project p2 has its own workspace with one other node. */
function workspace(nodes: unknown[]): void {
  const other = [{ id: 'z1', kind: 'terminal', name: 'Zest' }]
  unregister = registerWorkspaceLookup((id) => (id === 'w-p1' ? { name: 'Alpha WS', nodes } : id === 'w-p2' ? { name: 'Beta WS', nodes: other } : null))
}
function transcript(lines: unknown[]): string {
  const root = join(process.env.WEBTERM_DATA_DIR as string, 'transcripts')
  mkdirSync(root, { recursive: true })
  const path = join(root, 't.jsonl')
  writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'))
  return path
}
const read = (deps: NodeReadDeps, input: Record<string, unknown>) => execTool(ctx(deps), 'node.inspect', { projectId: 'p1', ...input })

describe('node.inspect', () => {
  it('finds a user-opened Claude node by id or case-insensitive name, with status and model', async () => {
    workspace([{ id: 't1', kind: 'terminal', name: 'Mango' }, { id: 'c1', kind: 'agent', agentId: 'claude', name: 'Dill', title: 'fix bug', cwd: '/home/u/x', cmd: 'claude' }])
    const core = new Probe()
    core.reg.setStatus('c1', 'working')
    core.reg.setTranscript('c1', transcript([
      'partial line from a tail window',
      { type: 'assistant', message: { model: 'claude-sonnet-4-5' } },
      { type: 'user', message: { content: 'hi' } },
      { type: 'assistant', message: { model: 'claude-opus-4-6' } },
      { type: 'assistant', message: { model: '<synthetic>' } },
      { type: 'system' },
    ]))
    const live: NodeSessionView = { ...bind(core), isLive: (id) => id === 'c1', getTerminal: () => 'line1\nline2\n' }
    for (const nodeRef of ['c1', 'dill', 'DILL']) {
      const res = await read({ sessions: () => live }, { nodeRef })
      expect(res).toMatchObject({ ok: true })
      expect(res.data).toEqual({ id: 'c1', name: 'Dill', kind: 'agent', title: 'fix bug', agentId: 'claude', live: true, status: 'working', model: 'claude-opus-4-6', output: ['line1', 'line2'] })
    }
    const text = JSON.stringify((await read({ sessions: () => live }, { nodeRef: 'Dill' })).data)
    for (const leak of ['/home/u/x', 't.jsonl', 'transcripts']) expect(text).not.toContain(leak)
  })

  it('a node of another project or an unknown ref is node_not_found; bad input is invalid_shape', async () => {
    workspace([{ id: 'c1', kind: 'agent', name: 'Dill' }])
    expect(await read({}, { nodeRef: 'Ghost' })).toMatchObject({ ok: false, code: 'node_not_found' })
    for (const nodeRef of ['Dill', 'c1']) expect(await execTool(ctx(), 'node.inspect', { projectId: 'p2', nodeRef })).toMatchObject({ ok: false, code: 'node_not_found' })
    expect(await execTool(ctx(), 'node.inspect', { projectId: 'p2', nodeRef: 'zest' })).toMatchObject({ ok: true, data: { id: 'z1' } })
    for (const bad of [{}, { nodeRef: '' }, { nodeRef: 'Dill', tail: 0 }, { nodeRef: 'Dill', tail: 201 }, { nodeRef: 'Dill', tail: 'x' }, { nodeRef: 5 }]) {
      expect(await read({}, bad)).toMatchObject({ ok: false, code: 'invalid_shape' })
    }
  })

  it('tails the terminal, strips escapes and redacts broker and credential-shaped secrets', async () => {
    workspace([{ id: 't1', kind: 'terminal', name: 'Mango' }])
    const core = new Probe()
    const lines = Array.from({ length: 80 }, (_, i) => `row ${i}`)
    const term = `${lines.join('\n')}\n\x1b[31mkey broker-secret-value-123 and sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123\x1b[0m\n\n`
    const deps: NodeReadDeps = { sessions: () => ({ ...bind(core), getTerminal: () => term }), secrets: () => ['broker-secret-value-123'] }
    const def = (await read(deps, { nodeRef: 'Mango' })).data as { output: string[]; model: unknown; status: unknown; live: boolean }
    expect(def.output.length).toBe(50)
    expect([def.model, def.status, def.live]).toEqual([null, null, false])
    const two = ((await read(deps, { nodeRef: 'Mango', tail: 2 })).data as { output: string[] }).output
    expect(two[0]).toBe('row 79')
    expect(two[1]).toMatch(/^key \[redacted\] and /)
    const dump = JSON.stringify(two)
    for (const leak of ['broker-secret-value-123', 'abcdefghijklmnopqrstuvwxyz0123', '\\u001b']) expect(dump).not.toContain(leak)
  })

  it('a dead session reads its exit tombstone output', async () => {
    workspace([{ id: 'c1', kind: 'agent', agentId: 'claude', name: 'Dill' }])
    const core = new Probe()
    core.reg.setExit('c1', { code: 0, reason: 'self', at: 1, output: 'bye\nexited' })
    const res = await read({ sessions: () => core }, { nodeRef: 'Dill' })
    expect(res.data).toMatchObject({ live: false, output: ['bye', 'exited'] })
  })

  it('split terminals read the first live pane; a transcript outside the allowed roots gives no model', async () => {
    workspace([{ id: 't2', kind: 'terminal', name: 'Kiwi', panes: { dir: 'h', ratio: 0.5, a: { id: 'p-a' }, b: { id: 'p-b' } } }])
    const core = new Probe()
    const outside = join(dir, 'outside.jsonl')
    writeFileSync(outside, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-6' } }))
    core.reg.setTranscript('p-b', outside)
    core.reg.setStatus('p-b', 'waiting')
    const view: NodeSessionView = { ...bind(core), isLive: (id) => id === 'p-b', getTerminal: (id) => `pane ${id}` }
    expect((await read({ sessions: () => view }, { nodeRef: 'kiwi' })).data).toMatchObject({ live: true, status: 'waiting', model: null, output: ['pane p-b'] })
  })

  it('browser/files nodes carry no session fields', async () => {
    workspace([{ id: 'b1', kind: 'browser', name: 'Fig', url: 'https://x.test/?token=abc' }])
    const res = await read({ sessions: () => { throw new Error('sessions must not be touched') } }, { nodeRef: 'Fig' })
    expect(res.data).toMatchObject({ kind: 'browser', live: false, status: null, model: null, output: [] })
    expect(JSON.stringify(res)).not.toContain('token=abc')
  })
})

describe('lastAssistantModel', () => {
  it('takes the last real assistant model and tolerates junk', () => {
    expect(lastAssistantModel(null)).toBeNull()
    expect(lastAssistantModel('{"type":"assistant"\n{"type":"assistant","message":{"model":"<synthetic>"}}')).toBeNull()
    expect(lastAssistantModel('{"type":"assistant","message":{"model":"a"}}\n{"type":"user","message":{"model":"assistant"}}')).toBe('a')
  })
})

/** The four SessionsCore methods node.inspect uses, bound so they can be spread into a fake. */
function bind(core: SessionsCore): NodeSessionView {
  return { isLive: (id) => core.isLive(id), statusOf: (id) => core.statusOf(id), getTerminal: (id) => core.getTerminal(id), getTranscript: (id) => core.getTranscript(id) }
}
