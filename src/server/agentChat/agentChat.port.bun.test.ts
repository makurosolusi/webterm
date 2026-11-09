// The Central-facing chat port over a real pool and the scripted fake Claude: node checks, input
// validation, a send that starts the session, config/mode changes, and the pool storing what the
// session changed on its node (seeded config, session id, mode) without a browser.
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Workspace, WsNode } from '../../shared/workspace'

const dataDir = mkdtempSync(join(tmpdir(), 'wt-chat-port-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'wt-chat-port-claude-'))
const restoreEnv = { data: process.env.WEBTERM_DATA_DIR, claude: process.env.CLAUDE_CONFIG_DIR }
process.env.WEBTERM_DATA_DIR = dataDir // the ladder reads settings: never the real data dir
process.env.CLAUDE_CONFIG_DIR = claudeDir
const { AgentChatPool } = await import('./agentChat.pool')
type AgentChatNodePatch = import('./agentChat.pool').AgentChatNodePatch
const { createAgentChatPort } = await import('./agentChat.port')
const { SCRIPTED_ANSWER, SCRIPTED_SESSION_ID, scriptedClaude } = await import('./agentChat.scriptedClaude')

afterAll(() => {
  if (restoreEnv.data === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = restoreEnv.data
  if (restoreEnv.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = restoreEnv.claude
  for (const d of [dataDir, claudeDir]) rmSync(d, { recursive: true, force: true })
})

const WAIT_MS = 3_000
async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + WAIT_MS
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Two boards; `persist` applies each patch to the stored node, as CanvasPush.update does. */
function rig(chat: Partial<WsNode> = {}, load?: (id: string) => Promise<SessionMessage[]>) {
  const node = (n: Partial<WsNode> & { id: string; kind: WsNode['kind'] }): WsNode => ({ x: 0, y: 0, ...n })
  const list: Workspace[] = [
    { id: 'w1', name: 'w1', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0, nodes: [node({ id: 'chat', kind: 'agentChat', ...chat }), node({ id: 'term', kind: 'terminal' })] },
    { id: 'w2', name: 'w2', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0, nodes: [] },
  ]
  const persisted: Array<{ workspaceId: string; nodeId: string; patch: AgentChatNodePatch }> = []
  const fake = scriptedClaude()
  const pool = new AgentChatPool({
    lookup: (nodeId) => {
      for (const ws of list) {
        const n = ws.nodes.find((x) => x.id === nodeId)
        if (n) return { ws, node: n }
      }
      return undefined
    },
    opener: () => fake.opener,
    persist: (workspaceId, nodeId, patch) => {
      persisted.push({ workspaceId, nodeId, patch })
      const ws = list.find((w) => w.id === workspaceId)!
      ws.nodes = ws.nodes.map((n) => {
        if (n.id !== nodeId) return n
        const { chatSessionId, ...rest } = patch
        const next: WsNode = { ...n, ...rest }
        if (chatSessionId === null) delete next.chatSessionId
        else if (chatSessionId !== undefined) next.chatSessionId = chatSessionId
        return next
      })
    },
  })
  current = pool
  const port = createAgentChatPort({ pool, ...(load ? { load } : {}) })
  const stored = (): WsNode => list[0].nodes[0]
  return { pool, port, fake, persisted, stored }
}

let current: InstanceType<typeof AgentChatPool> | undefined
afterEach(() => { current?.closeAll(); current = undefined })

describe('chat port', () => {
  test('node_not_found for an unknown node, a non-chat node and a chat node of another workspace; no session is created', async () => {
    const { pool, port } = rig()
    const nf = { ok: false, code: 'node_not_found', hint: 'No agent chat node with this id in this workspace.' }
    expect(await port.send('w1', 'missing', 'hi')).toEqual(nf)
    expect(await port.send('w1', 'term', 'hi')).toEqual(nf)
    expect(await port.send('w2', 'chat', 'hi')).toEqual(nf)
    expect(await port.configure('w2', 'chat', { model: 'opus' })).toEqual(nf)
    expect(await port.setMode('w2', 'chat', 'plan')).toEqual(nf)
    expect(await port.tail('w2', 'chat', 5)).toEqual([])
    expect(port.snapshot('w2', 'chat')).toMatchObject({ live: false, status: null, model: null })
    expect(pool.nodeIds()).toEqual([])
  })

  test('refuses empty text, a bad config patch and an unknown mode, changing nothing', async () => {
    const { pool, port, persisted } = rig()
    expect(await port.send('w1', 'chat', '   ')).toMatchObject({ ok: false, code: 'invalid_text' })
    expect(await port.configure('w1', 'chat', { thinking: 'yes' as never })).toMatchObject({ ok: false, code: 'invalid_config' })
    const bad = await port.configure('w1', 'chat', { effort: 7 as never })
    expect(bad.ok === false && bad.code === 'invalid_config' && typeof bad.hint).toBe('string')
    expect(await port.setMode('w1', 'chat', 'yolo')).toMatchObject({ ok: false, code: 'invalid_mode' })
    expect(pool.nodeIds()).toEqual([])
    expect(persisted).toEqual([])
  })

  test('send starts the session with the fake Claude, which stores the session id and mode; a second send joins the live one', async () => {
    const { port, fake, persisted, stored } = rig({ chatConfig: { model: 'opus', thinking: true } })
    expect(port.snapshot('w1', 'chat')).toMatchObject({ live: false, status: null, model: 'opus' })
    expect(await port.send('w1', 'chat', 'list the folder')).toEqual({ ok: true, started: true })
    await until(() => port.snapshot('w1', 'chat').pending !== null, 'the permission prompt')
    const snap = port.snapshot('w1', 'chat')
    expect(snap).toMatchObject({ live: true, status: 'awaiting', model: 'claude-fake', permissionMode: 'manual', pending: { tool: 'Bash' } })
    expect(fake.opens).toHaveLength(1)
    expect(fake.opens[0].prompts).toEqual(['list the folder'])
    // The seeded config equals the stored one: nothing to store. The init brings the id and mode.
    expect(persisted).toEqual([{ workspaceId: 'w1', nodeId: 'chat', patch: { chatSessionId: SCRIPTED_SESSION_ID, permissionMode: 'manual' } }])
    expect(stored()).toMatchObject({ chatSessionId: SCRIPTED_SESSION_ID, permissionMode: 'manual' })
    expect(await port.send('w1', 'chat', 'and then?')).toEqual({ ok: true, started: false })
    expect(fake.opens).toHaveLength(1)
  })

  test('configure applies to the session and stores the node config once; setMode likewise', async () => {
    const { port, persisted, stored } = rig()
    expect(await port.configure('w1', 'chat', { model: 'haiku', effort: 'low' })).toEqual({ ok: true, config: { model: 'haiku', effort: 'low', thinking: true } })
    expect(stored().chatConfig).toEqual({ model: 'haiku', effort: 'low', thinking: true })
    expect(port.snapshot('w1', 'chat').config).toEqual({ model: 'haiku', effort: 'low', thinking: true })
    // The same config again: the session re-emits it, the stored node already matches.
    await port.configure('w1', 'chat', { model: 'haiku' })
    expect(persisted.filter((p) => p.patch.chatConfig)).toHaveLength(1)
    expect(await port.setMode('w1', 'chat', 'plan')).toEqual({ ok: true, permissionMode: 'plan' })
    expect(stored().permissionMode).toBe('plan')
    expect(port.snapshot('w1', 'chat').permissionMode).toBe('plan')
    await port.setMode('w1', 'chat', 'plan')
    expect(persisted.filter((p) => p.patch.permissionMode)).toEqual([{ workspaceId: 'w1', nodeId: 'chat', patch: { permissionMode: 'plan' } }])
  })

  test('tail: saved transcript of the node session plus live turns not in it, newest last', async () => {
    const asked: string[] = []
    const transcript: SessionMessage[] = [
      { type: 'user', uuid: 'u-old', session_id: 's-old', parent_tool_use_id: null, message: { role: 'user', content: 'earlier question' } },
      { type: 'assistant', uuid: 'a-old', session_id: 's-old', parent_tool_use_id: null, message: { id: 'm-old', role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] } },
    ] as SessionMessage[]
    const { port, pool } = rig({ chatSessionId: 's-old' }, async (id) => { asked.push(id); return transcript })
    expect(await port.tail('w1', 'chat', 10)).toEqual([{ role: 'user', text: 'earlier question' }, { role: 'assistant', text: 'earlier answer' }])
    expect(asked).toEqual(['s-old'])
    await port.send('w1', 'chat', 'next one')
    await until(() => port.snapshot('w1', 'chat').pending !== null, 'the permission prompt')
    const req = pool.gate.pending('chat')[0]
    expect(req).toBeDefined()
    pool.gate.answer('chat', { requestId: req.requestId, behavior: 'allow' })
    await until(() => port.snapshot('w1', 'chat').status === 'idle', 'the turn to end')
    const turns = await port.tail('w1', 'chat', 3)
    expect(turns.at(-1)).toEqual({ role: 'assistant', text: SCRIPTED_ANSWER })
    expect(turns).toHaveLength(3)
    expect(turns[0]).toEqual({ role: 'user', text: 'next one' })
  })
})

describe('pool seeding', () => {
  test('a new session starts from the node stored config without storing it back', () => {
    const { pool, persisted } = rig({ chatConfig: { model: 'sonnet', effort: 'high', thinking: false } })
    const s = pool.session('chat')!
    expect(s.events(0).filter((e) => e.t === 'config').map((e) => (e as { config: unknown }).config)).toEqual([{ model: 'sonnet', effort: 'high', thinking: false }])
    expect(persisted).toEqual([])
  })

  test('a node without a config gets no seeded config event', () => {
    const { pool } = rig()
    expect(pool.session('chat')!.events(0).some((e) => e.t === 'config')).toBe(false)
  })
})
