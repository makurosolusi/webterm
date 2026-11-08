import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChatEvent } from '../../shared/agentChat.wire'
import type { Workspace, WsNode } from '../../shared/workspace'
import { FakeQuery, fx } from './agentChat.fakeQuery'
import {
  AGENT_CHAT_MAX_LIVE, AGENT_CHAT_OVER_CAP_NOTICE, AgentChatPool, activeAgentChatPool, agentChatOpenConfig, closeRemovedAgentChats, closeWorkspaceAgentChats, setAgentChatPool, type AgentChatTarget,
} from './agentChat.pool'

interface Opened { target: AgentChatTarget; resume?: string; canUseTool: CanUseTool; abort: AbortController; fq: FakeQuery }

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

const workspace = (id: string, nodes: Array<Partial<WsNode> & { id: string }>, cwd?: string): Workspace => ({
  id, name: id, ...(cwd ? { cwd } : {}), viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0,
  nodes: nodes.map((n) => ({ kind: 'agentChat', x: 0, y: 0, ...n })),
})

function rig(list: Workspace[], o: { maxLive?: number; onOpen?: (x: Opened) => void } = {}) {
  const opens: Opened[] = []
  const pool = new AgentChatPool({
    lookup: (nodeId) => {
      for (const ws of list) {
        const node = ws.nodes.find((n) => n.id === nodeId)
        if (node) return { ws, node }
      }
      return undefined
    },
    opener: (target) => (resume, canUseTool, abort, input) => {
      const x = { target, resume, canUseTool, abort, fq: new FakeQuery(input.prompt) }
      opens.push(x)
      o.onOpen?.(x)
      return x.fq.asQuery()
    },
    ...(o.maxLive ? { maxLive: o.maxLive } : {}),
  })
  const events = (nodeId: string): AgentChatEvent[] => pool.session(nodeId)?.events(0) ?? []
  return { pool, opens, events }
}

let current: AgentChatPool | undefined
afterEach(() => { current?.closeAll(); current = undefined; setAgentChatPool(undefined) })

describe('AgentChatPool', () => {
  test('creates the session lazily, only for agentChat nodes, resuming the node chatSessionId', () => {
    const ws = workspace('w1', [{ id: 'chat', chatSessionId: 's-old', permissionMode: 'plan' }, { id: 'term', kind: 'terminal' }])
    const { pool, opens } = rig([ws])
    current = pool
    expect(pool.nodeIds()).toEqual([])
    expect(pool.session('term')).toBe(undefined)
    expect(pool.session('missing')).toBe(undefined)
    const s = pool.session('chat')
    expect(pool.session('chat')).toBe(s)
    expect(opens).toHaveLength(0)
    expect(pool.send('chat', 'hi')).toEqual({ ok: true })
    expect(opens[0]?.resume).toBe('s-old')
    expect(opens[0]?.target.node.permissionMode).toBe('plan')
  })

  test('every open reads the node as stored now (profile/mode changes reach the next open)', async () => {
    const ws = workspace('w1', [{ id: 'chat' }])
    const { pool, opens } = rig([ws])
    current = pool
    pool.send('chat', 'one')
    opens[0]?.fq.emit(fx.init('s-1'), fx.result())
    await tick()
    pool.session('chat')?.suspend()
    ws.nodes[0] = { ...(ws.nodes[0] as WsNode), claudeProfileId: 'p2' }
    pool.send('chat', 'two')
    expect(opens[1]?.resume).toBe('s-1')
    expect(opens[1]?.target.node.claudeProfileId).toBe('p2')
    expect(pool.sessionId('chat')).toBe('s-1')
  })

  test('open config: node cwd, else workspace cwd, resolved like the PTY; node mode else the settings default', () => {
    const dir = tmpdir()
    const ws = workspace('w1', [{ id: 'a' }, { id: 'b', cwd: '/definitely/not/here', permissionMode: 'acceptEdits', claudeProfileId: 'p1' }], dir)
    const [a, b] = ws.nodes as [WsNode, WsNode]
    expect(agentChatOpenConfig({ ws, node: a }, { port: 8700, mode: 'auto' })).toEqual({ nodeId: 'a', port: 8700, cwd: dir, profileId: undefined, mode: 'auto', workspaceId: 'w1' })
    expect(agentChatOpenConfig({ ws, node: b }, { port: 8700, mode: 'auto' })).toMatchObject({ cwd: process.env.HOME || homedir(), profileId: 'p1', mode: 'acceptEdits' })
  })

  test('over the cap the least recently active idle Query is suspended, resumable, never a busy one', async () => {
    const ws = workspace('w1', [{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    const { pool, opens, events } = rig([ws], { maxLive: 2 })
    current = pool
    pool.send('a', 'x')
    opens[0]?.fq.emit(fx.init('s-a'), fx.result())
    await tick(5)
    pool.send('b', 'x')
    opens[1]?.fq.emit(fx.init('s-b'), fx.result())
    await tick(5)
    pool.send('c', 'x') // busy from here on: no result
    expect(opens[0]?.fq.closed).toBe(true)
    expect(opens[1]?.fq.closed).toBe(false)
    expect(pool.session('a')?.status()).toBe('idle')
    expect(pool.session('a')?.live()).toBe(false)
    expect(events('a').at(-1)).toMatchObject({ t: 'status', status: 'idle' })
    pool.send('a', 'back')
    expect(opens[3]?.resume).toBe('s-a')
    expect(opens[1]?.fq.closed).toBe(true) // b was the idle one; c is busy
    expect(opens[2]?.fq.closed).toBe(false)
  })

  test('all live sessions busy: opens anyway over the cap and says so in a notice', () => {
    const ws = workspace('w1', [{ id: 'a' }, { id: 'b' }])
    const { pool, opens, events } = rig([ws], { maxLive: 1 })
    current = pool
    pool.send('a', 'x')
    expect(pool.send('b', 'y')).toEqual({ ok: true })
    expect(opens).toHaveLength(2)
    expect(opens[0]?.fq.closed).toBe(false)
    expect(events('b').find((e) => e.t === 'notice')).toMatchObject({ level: 'warn', text: AGENT_CHAT_OVER_CAP_NOTICE(1) })
  })

  test('default cap matches the browser live cap', () => {
    expect(AGENT_CHAT_MAX_LIVE).toBe(3)
  })

  test('node removed, workspace deleted and shutdown close the session with no child left, idempotently', async () => {
    const w1 = workspace('w1', [{ id: 'a' }, { id: 'b' }])
    const w2 = workspace('w2', [{ id: 'c' }])
    const children: ChildProcess[] = []
    const errors: string[] = []
    const { pool, events } = rig([w1, w2], { maxLive: 5, onOpen: (x) => { children.push(spawn('sleep', ['30'], { stdio: 'ignore', signal: x.abort.signal }).on('error', (e) => errors.push(e.name))) } })
    current = pool
    setAgentChatPool(pool)
    for (const id of ['a', 'b', 'c']) pool.send(id, 'go')
    const exits = children.map((c) => new Promise<string | null>((r) => c.once('exit', (_code, sig) => r(sig))))
    const kept = { ...w1, nodes: w1.nodes.filter((n) => n.id !== 'a') }
    const evA = events('a')
    closeRemovedAgentChats(w1, kept)
    closeRemovedAgentChats(w1, kept)
    expect(await exits[0]).toBe('SIGTERM')
    closeWorkspaceAgentChats(w2)
    expect(await exits[2]).toBe('SIGTERM')
    pool.closeAll()
    pool.closeAll()
    expect(await exits[1]).toBe('SIGTERM')
    expect(pool.nodeIds()).toEqual([])
    expect(evA.length).toBeGreaterThan(0)
    expect(children.every((c) => c.signalCode === 'SIGTERM')).toBe(true)
    expect(errors).toEqual(['AbortError', 'AbortError', 'AbortError'])
  })

  test('a close reports closed once with the reason and the lock is released', () => {
    const ws = workspace('w1', [{ id: 'a', chatSessionId: 's-a' }])
    const { pool } = rig([ws])
    current = pool
    const s = pool.session('a')
    const seen: AgentChatEvent[] = []
    s?.subscribe((e) => seen.push(e))
    pool.send('a', 'go')
    expect(pool.lock.owner('s-a')).toBe('a')
    pool.close('a', 'node removed')
    pool.close('a', 'node removed')
    expect(seen.filter((e) => e.t === 'status' && e.status === 'closed')).toMatchObject([{ detail: 'node removed' }])
    expect(pool.lock.owner('s-a')).toBe(undefined)
  })

  test('hooks are no-ops before any chat route created the pool', () => {
    const ws = workspace('w1', [{ id: 'a' }])
    // A throw here fails the test.
    closeRemovedAgentChats(ws, workspace('w1', []))
    closeWorkspaceAgentChats(ws)
    closeWorkspaceAgentChats(null)
    expect(activeAgentChatPool()).toBe(undefined)
  })
})
