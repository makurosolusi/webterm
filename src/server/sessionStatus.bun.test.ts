// Shared status source (sessions audit gaps 1, 2, 4): status reaches every UI socket, a connect gets a
// snapshot, the attention reason is kept (bounded, memory only) and carried, Agent Chat reports into
// the same registry. No PTY, no real Claude: SessionsCore + a fake Query.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { ServerMsg } from '../shared/protocol'
import type { AgentChatEvent } from '../shared/agentChat.wire'
import type { Workspace } from '../shared/workspace'

const DIR = mkdtempSync(join(tmpdir(), 'webterm-sessstatus-'))
const saved = { data: process.env.WEBTERM_DATA_DIR, home: process.env.HOME, claude: process.env.CLAUDE_CONFIG_DIR }
process.env.WEBTERM_DATA_DIR = DIR
process.env.HOME = DIR
process.env.CLAUDE_CONFIG_DIR = join(DIR, '.claude')
afterAll(() => {
  process.env.WEBTERM_DATA_DIR = saved.data
  process.env.HOME = saved.home
  process.env.CLAUDE_CONFIG_DIR = saved.claude
  rmSync(DIR, { recursive: true, force: true })
})

// Imported after the env above: a static import would run first and could read the real dirs.
const { SessionsCore } = await import('./sessionsCore')
const { STATUS_DETAIL_MAX } = await import('./nodeRegistry')
const { WORKING_STALE_MS } = await import('../shared/agentStale')
const { chatNodeStatus } = await import('./agentChat/agentChat.status')
const { nodeStatusOf } = await import('./nodeStatus.route')

function core() {
  const s = new SessionsCore({ now: () => 1000 })
  const frames: ServerMsg[] = []
  s.broadcast = (m) => frames.push(m)
  return { s, frames }
}

describe('status source', () => {
  test('a status reaches a client that never opened the PTY (broadcast), with its reason', () => {
    const { s, frames } = core()
    s.setStatus('other-board', 'blocked', 1000, { reason: 'permission', detail: 'Bash' })
    expect(frames).toEqual([{ t: 'status', id: 'other-board', status: 'blocked', reason: 'permission', detail: 'Bash' }])
  })

  test('a later status without a reason clears it; detail is capped and whitespace-folded', () => {
    const { s, frames } = core()
    s.setStatus('n', 'blocked', 1000, { reason: 'permission', detail: `  ${'x'.repeat(200)}\n` })
    const first = frames[0] as { detail: string }
    expect(first.detail.length).toBe(STATUS_DETAIL_MAX)
    expect(first.detail.endsWith('…')).toBe(true)
    s.setStatus('n', 'working')
    expect(frames[1]).toEqual({ t: 'status', id: 'n', status: 'working' })
    expect(s.statusEntryOf('n')?.reason).toBe(undefined)
  })

  test('a connecting socket gets every stored status as a snapshot', () => {
    const { s } = core()
    s.setStatus('a', 'working')
    s.setStatus('b', 'waiting', 1000, { reason: 'question' })
    expect(s.statusSnapshot()).toEqual([
      { t: 'status', id: 'a', status: 'working', snapshot: true },
      { t: 'status', id: 'b', status: 'waiting', reason: 'question', snapshot: true },
    ])
  })

  test('the stale sweep is broadcast too (clients fall back to liveness, not a frozen Working)', () => {
    const { s, frames } = core()
    s.setStatus('quiet', 'working', 0)
    s.sweepStale(WORKING_STALE_MS + 1)
    expect(frames.at(-1)).toEqual({ t: 'status', id: 'quiet' })
    expect(s.statusSnapshot()).toEqual([])
  })

  test('/api/node-status facts carry the reason', () => {
    const { s } = core()
    s.setStatus('n', 'blocked', 1000, { reason: 'permission', detail: 'Edit' })
    expect(nodeStatusOf('n', s, null)).toMatchObject({ live: false, status: 'blocked', reason: 'permission', detail: 'Edit' })
  })

  test('the durable snapshot holds status words only, never the reason text', () => {
    const s = new SessionsCore({ now: () => 1 })
    const saves: unknown[] = []
    s.statusStore = { save: (e: Iterable<unknown>) => saves.push([...e]) } as never
    s.setStatus('n', 'blocked', 1, { reason: 'permission', detail: 'secret-ish' })
    expect(JSON.stringify(saves)).not.toContain('secret-ish')
  })
})

describe('agent chat bridge', () => {
  const ev = (body: Record<string, unknown>): AgentChatEvent => ({ seq: 1, ...body }) as AgentChatEvent
  test('maps chat events onto node statuses', () => {
    expect(chatNodeStatus(ev({ t: 'status', status: 'thinking' }), false)).toEqual({ status: 'working' })
    expect(chatNodeStatus(ev({ t: 'status', status: 'tool' }), true)).toEqual({ status: 'working' })
    expect(chatNodeStatus(ev({ t: 'permission', requestId: 'r', kind: 'tool', toolName: 'Bash', toolUseId: 'u', input: {} }), true))
      .toEqual({ status: 'blocked', reason: { reason: 'permission', detail: 'Bash' } })
    expect(chatNodeStatus(ev({ t: 'permission', requestId: 'r', kind: 'question', toolName: 'AskUserQuestion', toolUseId: 'u', input: {} }), true))
      .toEqual({ status: 'waiting', reason: { reason: 'question' } })
    expect(chatNodeStatus(ev({ t: 'status', status: 'idle' }), true)).toEqual({ status: 'waiting' })
    expect(chatNodeStatus(ev({ t: 'status', status: 'idle' }), false)).toBe(null) // opened, no turn yet
    expect(chatNodeStatus(ev({ t: 'status', status: 'error', detail: 'error_max_turns' }), true)).toEqual({ status: 'failed', reason: { reason: 'error', detail: 'error_max_turns' } })
    expect(chatNodeStatus(ev({ t: 'status', status: 'closed' }), false)).toEqual({ status: 'stopped' })
    expect(chatNodeStatus(ev({ t: 'delta', messageId: 'm', kind: 'text', text: 'x' }), true)).toBe(null)
  })

  test('a live chat turn reports working, then needs you with the tool, into the registry', async () => {
    const [{ AgentChatPool }, { FakeQuery, fx }] = await Promise.all([import('./agentChat/agentChat.pool'), import('./agentChat/agentChat.fakeQuery')])
    const ws: Workspace = { id: 'w', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0, nodes: [{ id: 'chat', kind: 'agentChat', x: 0, y: 0 }] }
    const { s } = core()
    let canUseTool: CanUseTool | undefined
    const pool = new AgentChatPool({
      lookup: (id) => { const node = ws.nodes.find((n) => n.id === id); return node ? { ws, node } : undefined },
      opener: () => (_resume, cut, _abort, input) => { canUseTool = cut; const fq = new FakeQuery(input.prompt); fq.emit(fx.init('s-1')); return fq.asQuery() },
      onStatus: (id, st) => s.setStatus(id, st.status, undefined, st.reason),
    })
    try {
      pool.send('chat', 'hi')
      expect(s.statusOf('chat')).toBe('working')
      const ac = new AbortController()
      void canUseTool!('Bash', { command: 'ls' }, { signal: ac.signal, requestId: 'r1', toolUseID: 'u1' } as never)
      await new Promise((r) => setTimeout(r, 0))
      expect(s.statusMsgOf('chat')).toEqual({ t: 'status', id: 'chat', status: 'blocked', reason: 'permission', detail: 'Bash' })
      ac.abort()
    } finally {
      pool.closeAll()
    }
  })
})
