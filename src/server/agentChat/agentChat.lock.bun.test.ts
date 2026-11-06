import { afterEach, describe, expect, test } from 'bun:test'
import type { Workspace, WsNode } from '../../shared/workspace'
import { FakeQuery, fx } from './agentChat.fakeQuery'
import { AGENT_CHAT_LOCK_CHAT_NOTICE, AGENT_CHAT_LOCK_TERMINAL_NOTICE, AgentChatLock } from './agentChat.lock'
import { AgentChatPool } from './agentChat.pool'

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

const workspace = (nodes: Array<Partial<WsNode> & { id: string }>): Workspace => ({
  id: 'w1', name: 'w1', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0,
  nodes: nodes.map((n) => ({ kind: 'agentChat', x: 0, y: 0, ...n })),
})

function rig(ws: Workspace) {
  const opens: Array<{ nodeId: string; resume?: string; fq: FakeQuery }> = []
  const pool = new AgentChatPool({
    lookup: (nodeId) => {
      const node = ws.nodes.find((n) => n.id === nodeId)
      return node ? { ws, node } : undefined
    },
    opener: (t) => (resume, _canUseTool, _abort, input) => {
      const fq = new FakeQuery(input.prompt)
      opens.push({ nodeId: t.node.id, resume, fq })
      return fq.asQuery()
    },
  })
  const notices = (nodeId: string) => (pool.session(nodeId)?.events(0) ?? []).filter((e) => e.t === 'notice')
  return { pool, opens, notices }
}

let current: AgentChatPool | undefined
afterEach(() => { current?.closeAll(); current = undefined })

describe('AgentChatLock', () => {
  test('one owner per session id; the owner may re-claim; release frees every id of the node', () => {
    const lock = new AgentChatLock()
    expect(lock.acquire('s-1', 'a')).toEqual({ ok: true })
    expect(lock.acquire('s-1', 'a')).toEqual({ ok: true })
    expect(lock.acquire('s-1', 'b')).toEqual({ ok: false, reason: AGENT_CHAT_LOCK_CHAT_NOTICE })
    lock.acquire('s-2', 'a')
    lock.release('a')
    expect(lock.owner('s-1')).toBe(undefined)
    expect(lock.owner('s-2')).toBe(undefined)
    expect(lock.acquire('s-1', 'b')).toEqual({ ok: true })
  })

  test('a second chat node resuming the same session is refused with a notice, then allowed once the owner closes', () => {
    const ws = workspace([{ id: 'a', chatSessionId: 's-1' }, { id: 'b', chatSessionId: 's-1' }])
    const { pool, opens, notices } = rig(ws)
    current = pool
    expect(pool.send('a', 'hi')).toEqual({ ok: true })
    expect(pool.send('b', 'hi')).toEqual({ ok: false, status: 409, reason: AGENT_CHAT_LOCK_CHAT_NOTICE })
    expect(opens.map((o) => o.nodeId)).toEqual(['a'])
    expect(notices('b')).toMatchObject([{ level: 'warn', text: AGENT_CHAT_LOCK_CHAT_NOTICE }])
    pool.close('a')
    expect(pool.send('b', 'hi')).toEqual({ ok: true })
    expect(opens.at(-1)).toMatchObject({ nodeId: 'b', resume: 's-1' })
  })

  test('a terminal agent node of the workspace with the same sessionId blocks the resume', () => {
    const ws = workspace([{ id: 'chat', chatSessionId: 's-1' }, { id: 'term', kind: 'agent', agentId: 'claude', sessionId: 's-1' }])
    const { pool, opens, notices } = rig(ws)
    current = pool
    expect(pool.send('chat', 'hi')).toEqual({ ok: false, status: 409, reason: AGENT_CHAT_LOCK_TERMINAL_NOTICE })
    expect(opens).toHaveLength(0)
    expect(notices('chat')[0]?.text).toContain('already open in a terminal agent node')
    ws.nodes = ws.nodes.filter((n) => n.id !== 'term')
    expect(pool.send('chat', 'hi')).toEqual({ ok: true })
  })

  test('a fresh session id from init is claimed by its node and released on close', async () => {
    const ws = workspace([{ id: 'a' }, { id: 'b' }])
    const { pool, opens } = rig(ws)
    current = pool
    pool.send('a', 'hi')
    opens[0]?.fq.emit(fx.init('s-new'), fx.result())
    await tick()
    expect(pool.lock.owner('s-new')).toBe('a')
    expect(pool.lock.acquire('s-new', 'b').ok).toBe(false)
    pool.close('a')
    expect(pool.lock.owner('s-new')).toBe(undefined)
  })
})
