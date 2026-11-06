// End to end: the real API route table (handleApi) and the terminal WebSocket on a real HTTP server
// with a tmp data dir and a tmp CLAUDE_CONFIG_DIR. Only the Claude query opener is replaced, by the
// scripted fake (agentChat.scriptedClaude.ts); every request goes through the same surface the
// client uses: workspace saves, the agent chat SSE stream and POSTs, and /ws for the terminal agent.
import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { AgentChatEvent } from '../../shared/agentChat.wire'
import type { ServerMsg } from '../../shared/protocol'
import type { Workspace, WsNode } from '../../shared/workspace'
import { reapChildren } from '../processReap.testutil'
import {
  SCRIPTED_ANSWER, SCRIPTED_FAIL_MESSAGE, SCRIPTED_INTRO, SCRIPTED_SESSION_ID, SCRIPTED_TOOL_INPUT, SCRIPTED_TOOL_OUTPUT, scriptedClaude, scriptedToolId,
} from './agentChat.scriptedClaude'

const dataDir = mkdtempSync(join(tmpdir(), 'wt-chat-e2e-'))
const claudeDir = mkdtempSync(join(tmpdir(), 'wt-chat-e2e-claude-'))
const folder = mkdtempSync(join(tmpdir(), 'wt-chat-e2e-cwd-'))
const restoreEnv = { data: process.env.WEBTERM_DATA_DIR, claude: process.env.CLAUDE_CONFIG_DIR }
process.env.WEBTERM_DATA_DIR = dataDir // before ../api -> ../db opens
process.env.CLAUDE_CONFIG_DIR = claudeDir // nothing may reach the real ~/.claude
const { handleApi } = await import('../api')
const { db } = await import('../db')
const { findWorkspaceFor } = await import('../contextLinkRoute')
const { sessions } = await import('../sessions')
const { fsWatchHub } = await import('../fsWatch')
const { serveTerminalSocket } = await import('../terminalSocket')
const { WS_PATH } = await import('../../shared/protocol')
const { AgentChatPool, setAgentChatPool } = await import('./agentChat.pool')

const WAIT_MS = 5_000
const TEST_TIMEOUT_MS = 30_000
const UI = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
const fake = scriptedClaude()
// The production pool (routes/agentChat.routes.ts) with the same stored-node lookup; only the opener is fake.
const pool = new AgentChatPool({
  lookup: (nodeId) => {
    const ws = findWorkspaceFor(db.list(), nodeId)
    const node = ws?.nodes.find((n) => n.id === nodeId)
    return ws && node ? { ws, node } : undefined
  },
  opener: () => fake.opener,
})
setAgentChatPool(pool)

const server = http.createServer((req, res) => { if (!handleApi(req, res)) { res.statusCode = 404; res.end() } })
const wss = new WebSocketServer({ server, path: WS_PATH })
wss.on('connection', (ws) => serveTerminalSocket(ws, { sessions, fsWatchHub, watchOn: () => false, clients: () => wss.clients.size }))
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const streams: AbortController[] = []

afterAll(async () => {
  for (const s of streams) s.abort()
  pool.closeAll()
  setAgentChatPool(undefined)
  wss.close()
  server.closeAllConnections()
  server.close()
  process.env.WEBTERM_DATA_DIR = restoreEnv.data
  if (restoreEnv.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = restoreEnv.claude
  await reapChildren()
  for (const d of [claudeDir, folder]) rmSync(d, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(what: string, cond: () => boolean, ms = WAIT_MS): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await sleep(10)
  }
}

async function call<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = UI): Promise<{ status: number; body: T }> {
  const r = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await r.text()
  return { status: r.status, body: (text ? JSON.parse(text) : undefined) as T }
}

/** Live SSE subscription of one chat node: every event received so far. */
async function openStream(nodeId: string, lastEventId?: number): Promise<AgentChatEvent[]> {
  const ctl = new AbortController()
  streams.push(ctl)
  const headers = lastEventId === undefined ? UI : { ...UI, 'last-event-id': String(lastEventId) }
  const r = await fetch(`${base}/api/agent-chat/${nodeId}/stream?after=0`, { headers, signal: ctl.signal })
  expect(r.status).toBe(200)
  const events: AgentChatEvent[] = []
  const reader = (r.body as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  void (async () => {
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buf += dec.decode(value)
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const f of frames) {
        const data = f.split('\n').find((l) => l.startsWith('data: '))
        if (data) events.push(JSON.parse(data.slice(6)) as AgentChatEvent)
      }
    }
  })().catch((err: unknown) => { if (!ctl.signal.aborted) throw err })
  return events
}

const node = (n: Partial<WsNode> & { id: string; kind: string }): WsNode => ({ x: 0, y: 0, cwd: folder, ...n }) as WsNode
const chatNode = (id: string, extra: Partial<WsNode> = {}) => node({ id, kind: 'agentChat', agentId: 'claude', title: 'Agent Chat', ...extra })

async function board(name: string, nodes: WsNode[]): Promise<Workspace> {
  const created = await call<Workspace>('POST', '/api/workspaces', { name, cwd: folder })
  expect(created.status).toBe(201)
  return save({ ...created.body, nodes })
}

async function save(ws: Workspace): Promise<Workspace> {
  const r = await call<Workspace>('PUT', `/api/workspaces/${ws.id}`, ws)
  expect(r.status).toBe(200)
  return r.body
}

const of = <T extends AgentChatEvent['t']>(events: AgentChatEvent[], t: T) => events.filter((e): e is Extract<AgentChatEvent, { t: T }> => e.t === t)

describe('agent chat node, end to end', () => {
  test('streams a turn, asks for permission, completes, changes mode and stops when a save removes it', async () => {
    const chatId = `chat-${randomUUID()}`
    const termId = `term-${randomUUID()}`
    const term = node({ id: termId, kind: 'agent', agentId: 'claude', sessionId: randomUUID() })
    let ws = await board('chat-e2e', [chatNode(chatId), term])
    expect(ws.nodes.map((n) => n.kind).sort()).toEqual(['agent', 'agentChat'])
    expect((await call('POST', `/api/agent-chat/${chatId}/send`, { text: 'hi' }, { 'content-type': 'application/json' })).status).toBe(403) // UI only
    const events = await openStream(chatId)
    expect(fake.opens).toHaveLength(0) // lazy: no Claude until the first message

    expect((await call('POST', `/api/agent-chat/${chatId}/send`, { text: 'What is in this folder?' })).status).toBe(200)
    await until('the permission prompt', () => of(events, 'permission').length === 1)
    const opened = fake.opens[0]
    expect(fake.opens).toHaveLength(1)
    const toolId = opened ? scriptedToolId(opened, 1) : ''
    expect(opened?.prompts).toEqual(['What is in this folder?'])
    expect(of(events, 'init')[0]).toMatchObject({ sessionId: SCRIPTED_SESSION_ID })
    expect(of(events, 'delta').map((e) => e.text).join('')).toBe(SCRIPTED_INTRO.join(''))
    expect(of(events, 'tool')[0]).toMatchObject({ id: toolId, name: 'Bash', state: 'running', input: SCRIPTED_TOOL_INPUT })
    const prompt = of(events, 'permission')[0]
    expect(prompt).toMatchObject({ kind: 'tool', toolName: 'Bash', toolUseId: toolId, input: SCRIPTED_TOOL_INPUT })
    expect(of(events, 'status').at(-1)?.status).toBe('awaiting')

    const answer = { requestId: prompt?.requestId, behavior: 'allow', updatedInput: SCRIPTED_TOOL_INPUT }
    expect((await call('POST', `/api/agent-chat/${chatId}/permission`, answer)).status).toBe(200)
    await until('the result', () => of(events, 'result').length === 1)
    expect(of(events, 'permissionResolved')).toMatchObject([{ requestId: prompt?.requestId, outcome: 'allow' }])
    expect(of(events, 'tool').at(-1)).toMatchObject({ id: toolId, state: 'done', result: SCRIPTED_TOOL_OUTPUT })
    expect(of(events, 'message').some((m) => m.role === 'assistant' && m.parts.some((p) => p.k === 'text' && p.text === SCRIPTED_ANSWER))).toBe(true)
    expect(of(events, 'result')[0]).toMatchObject({ isError: false, interrupted: false, denials: 0 })
    expect((await call('POST', `/api/agent-chat/${chatId}/permission`, answer)).status).toBe(409) // already answered

    expect((await call('POST', `/api/agent-chat/${chatId}/mode`, { mode: 'plan' })).status).toBe(200)
    await until('the mode event', () => of(events, 'mode').some((e) => e.mode === 'plan'))
    expect(opened?.fq.modes).toEqual(['plan'])

    // The client writes the session id from `init` into the node; the board round-trips both kinds.
    ws = await save({ ...ws, nodes: ws.nodes.map((n) => (n.id === chatId ? { ...n, chatSessionId: SCRIPTED_SESSION_ID, permissionMode: 'plan' } : n)) })
    const stored = (await call<Workspace>('GET', `/api/workspaces/${ws.id}`)).body
    expect(stored.nodes.find((n) => n.id === chatId)).toMatchObject({ kind: 'agentChat', chatSessionId: SCRIPTED_SESSION_ID, permissionMode: 'plan' })
    expect(stored.nodes.find((n) => n.id === termId)).toMatchObject({ kind: 'agent', agentId: 'claude', sessionId: term.sessionId })

    await save({ ...ws, nodes: ws.nodes.filter((n) => n.id !== chatId) })
    await until('the closed status', () => of(events, 'status').some((e) => e.status === 'closed'))
    expect(of(events, 'status').at(-1)).toMatchObject({ status: 'closed', detail: 'node removed' })
    expect(opened?.fq.closed).toBe(true)
    expect(opened?.abort.signal.aborted).toBe(true)
    expect(pool.nodeIds()).not.toContain(chatId)
    expect((await call('POST', `/api/agent-chat/${chatId}/send`, { text: 'still there?' })).status).toBe(404)
    expect(fake.opens).toHaveLength(1)
  }, TEST_TIMEOUT_MS)

  test('deleting the workspace stops a chat waiting on a prompt and expires the prompt', async () => {
    const chatId = `chat-${randomUUID()}`
    const ws = await board('chat-e2e-delete', [chatNode(chatId)])
    const events = await openStream(chatId)
    const before = fake.opens.length
    expect((await call('POST', `/api/agent-chat/${chatId}/send`, { text: 'List it' })).status).toBe(200)
    await until('the permission prompt', () => of(events, 'permission').length === 1)
    expect((await call('DELETE', `/api/workspaces/${ws.id}`)).status).toBe(204)
    await until('the closed status', () => of(events, 'status').some((e) => e.status === 'closed'))
    const opened = fake.opens[before]
    expect(of(events, 'permissionResolved')).toMatchObject([{ outcome: 'expired' }])
    expect(of(events, 'status').at(-1)).toMatchObject({ status: 'closed', detail: 'workspace deleted' })
    expect(opened?.fq.closed).toBe(true)
    expect(of(events, 'result')).toHaveLength(0)
    expect(pool.nodeIds()).not.toContain(chatId)
  }, TEST_TIMEOUT_MS)

  test('a crashed stream shows an error and the next message resumes the same Claude session', async () => {
    const chatId = `chat-${randomUUID()}`
    await board('chat-e2e-crash', [chatNode(chatId)])
    const events = await openStream(chatId)
    const before = fake.opens.length
    expect((await call('POST', `/api/agent-chat/${chatId}/send`, { text: 'please crash' })).status).toBe(200)
    await until('the error status', () => of(events, 'status').some((e) => e.status === 'error'))
    expect(of(events, 'notice').some((n) => n.level === 'error' && n.text.includes(SCRIPTED_FAIL_MESSAGE) && n.text.includes(chatId))).toBe(true)
    expect((await call('POST', `/api/agent-chat/${chatId}/send`, { text: 'try again' })).status).toBe(200)
    await until('the second open', () => fake.opens.length === before + 2)
    expect(fake.opens[before + 1]?.resume).toBe(SCRIPTED_SESSION_ID)
    await until('the permission prompt', () => of(events, 'permission').length === 1)
    const prompt = of(events, 'permission')[0]
    const deny = { requestId: prompt?.requestId, behavior: 'deny', message: 'Not now' }
    expect((await call('POST', `/api/agent-chat/${chatId}/permission`, deny)).status).toBe(200)
    await until('the result', () => of(events, 'result').length === 1)
    const reopened = fake.opens[before + 1]
    expect(of(events, 'tool').at(-1)).toMatchObject({ id: reopened ? scriptedToolId(reopened, 1) : '', state: 'denied' })
    expect(of(events, 'result')[0]).toMatchObject({ denials: 1 })
  }, TEST_TIMEOUT_MS)

  test('stop during a prompt cancels the prompt and ends the turn as stopped, not as an error', async () => {
    const chatId = `chat-${randomUUID()}`
    const ws = await board('chat-e2e-stop', [chatNode(chatId)])
    const events = await openStream(chatId)
    expect((await call('POST', `/api/agent-chat/${chatId}/send`, { text: 'List it' })).status).toBe(200)
    await until('the permission prompt', () => of(events, 'permission').length === 1)
    expect((await call('POST', `/api/agent-chat/${chatId}/interrupt`, {})).status).toBe(200)
    await until('the result', () => of(events, 'result').length === 1)
    expect(of(events, 'permissionResolved')).toMatchObject([{ outcome: 'cancelled' }])
    expect(of(events, 'result')[0]).toMatchObject({ interrupted: true })
    expect(of(events, 'status').at(-1)?.status).toBe('interrupted')
    expect(of(events, 'notice').filter((n) => n.level === 'error')).toEqual([])
    expect((await call('DELETE', `/api/workspaces/${ws.id}`)).status).toBe(204)
  }, TEST_TIMEOUT_MS)

  test('a page left open across a server restart keeps receiving events past its cursor', async () => {
    const chatId = `chat-${randomUUID()}`
    const ws = await board('chat-e2e-restart', [chatNode(chatId)])
    const cursor = 500 // the EventSource reconnects with the seq it saw before the restart
    const events = await openStream(chatId, cursor)
    expect((await call('POST', `/api/agent-chat/${chatId}/send`, { text: 'Still there?' })).status).toBe(200)
    await until('the permission prompt', () => of(events, 'permission').length === 1)
    expect(events.every((e) => e.seq > cursor)).toBe(true)
    expect((await call('DELETE', `/api/workspaces/${ws.id}`)).status).toBe(204)
  }, TEST_TIMEOUT_MS)

  test('the terminal agent node next to a chat still opens its PTY over /ws and never reaches the chat pool', async () => {
    const chatId = `chat-${randomUUID()}`
    const termId = `term-${randomUUID()}`
    const ws = await board('chat-e2e-terminal', [chatNode(chatId), node({ id: termId, kind: 'agent', agentId: 'claude' })])
    expect((await call('GET', `/api/agent-chat/${termId}/history`)).status).toBe(404)
    expect(pool.session(termId)).toBe(undefined)
    const sock = new WebSocket(`${base.replace('http', 'ws')}${WS_PATH}`)
    const out: ServerMsg[] = []
    sock.on('message', (d) => out.push(JSON.parse(String(d)) as ServerMsg))
    await new Promise<void>((r, j) => { sock.once('open', () => r()); sock.once('error', j) })
    try {
      // The terminal agent path as the canvas opens it (agentId claude), with a harmless command
      // instead of the claude binary so no real Claude starts.
      sock.send(JSON.stringify({ t: 'open', id: termId, cols: 80, rows: 24, cwd: folder, cmd: 'echo AGENT_PTY_$((40+2))', agentId: 'claude' }))
      // Output arrives in chunks that can split the marker.
      const printed = (): string => out.map((m) => (m.t === 'output' && m.id === termId ? m.data : '')).join('')
      await until('the PTY output', () => printed().includes('AGENT_PTY_42')).catch((err: unknown) => {
        throw new Error(`terminal node ${termId}: ${String(err)}; got ${JSON.stringify(printed().slice(-300))}, messages ${JSON.stringify(out.map((m) => m.t))}`)
      })
      expect(pool.nodeIds()).not.toContain(termId)
      expect(fake.opens.every((o) => !o.prompts.some((p) => p.includes('AGENT_PTY')))).toBe(true)
    } finally {
      sock.close()
      expect((await call('DELETE', `/api/workspaces/${ws.id}`)).status).toBe(204)
    }
  }, TEST_TIMEOUT_MS)
})
