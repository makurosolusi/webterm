// The Agent Chat stream over the terminal WebSocket (sseBridge.ts): the REAL /api dispatcher
// (handleApi -> uiOnly -> agentChatRoute) behind the same outer gate as index.ts `allowed()`, fed
// the headers a real browser WebSocket upgrade carries. Locks the "Connecting to Claude..." bug:
// a uiOnly route refused every bridged stream when the upgrade carried no `sec-fetch-site`.
import { TEST_SESSION, TEST_UI_COOKIE } from './uiSession.testutil'
import { afterEach, describe, expect, it } from 'bun:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMsg } from '../shared/protocol'
import type { Workspace, WsNode } from '../shared/workspace'

// test-only: never touch the real ~/.webterm-server or ~/.claude.
const tmp = mkdtempSync(join(tmpdir(), 'ssebridge-chat-'))
process.env.WEBTERM_DATA_DIR = join(tmp, 'data')
process.env.HOME = tmp
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')

const { createStreamBridge } = await import('./sseBridge')
const { handleApi } = await import('./api')
const { authorizeRequest, TOKEN_HEADER } = await import('./auth')
const { refuseRequest } = await import('./bootWiring')
const { AgentChatPool, setAgentChatPool } = await import('./agentChat/agentChat.pool')
const { FakeQuery } = await import('./agentChat/agentChat.fakeQuery')
const { isValidNodeToken, nodeToken } = await import('./hooksTokens')

/** A real agent node token (what an agent PTY's WEBTERM_TOKEN carries). */
const NODE_TOKEN = nodeToken('agent-1')
const HOST = '127.0.0.1:8799'
const ORIGIN = `http://${HOST}`

const nodes: WsNode[] = []
const ws: Workspace = { id: 'w1', name: 'w1', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], updatedAt: 0, nodes }
const addNode = (id: string): void => { nodes.push({ id, kind: 'agentChat', x: 0, y: 0 } as WsNode) }
setAgentChatPool(new AgentChatPool({
  lookup: (id) => { const node = nodes.find((n) => n.id === id); return node ? { ws, node } : undefined },
  opener: () => (_r, _c, _a, input) => new FakeQuery(input.prompt).asQuery(),
}))

/** index.ts routeApp after the upgrade: outer gate (token off, cookie sessions), then handleApi. */
function routeApp(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x')
  const ok = authorizeRequest({
    headers: req.headers, expectedToken: undefined, pathname: url.pathname,
    isNodeToken: isValidNodeToken, isUiSession: (v) => v === TEST_SESSION,
  })
  if (!ok) return refuseRequest(res)
  if (!handleApi(req, res)) { res.statusCode = 404; res.end() }
}

/** Headers of a browser WebSocket handshake from the webterm page itself. */
const UPGRADE = { host: HOST, origin: ORIGIN, cookie: TEST_UI_COOKIE, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }
const CHROME = { ...UPGRADE, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'websocket', 'sec-fetch-dest': 'websocket' }

function bridge(headers: Record<string, string>) {
  const frames: ServerMsg[] = []
  const b = createStreamBridge({ headers, socket: { remoteAddress: '127.0.0.1' } }, (m) => frames.push(m), routeApp, () => 0)
  return { b, frames }
}
const settle = async (frames: ServerMsg[]): Promise<void> => { for (let i = 0; i < 50 && frames.length === 0; i++) await new Promise((r) => setTimeout(r, 5)) }

addNode('chat')
const open: Array<{ closeAll(): void }> = []
afterEach(() => { for (const b of open.splice(0)) b.closeAll() })
// No rmSync of `tmp`: test:bun runs every file in one process, and the db singleton opened here stays
// open for the files after this one (deleting it under them is a SQLite disk I/O error).

describe('agent chat stream over the socket bridge', () => {
  for (const [name, headers] of [['with sec-fetch-* (Chromium)', CHROME], ['without any sec-fetch-*', UPGRADE]] as const) {
    it(`opens for a same-origin signed-in UI upgrade ${name}`, async () => {
      const { b, frames } = bridge(headers)
      open.push(b)
      b.sub('c1', '/api/agent-chat/chat/stream')
      await settle(frames)
      expect(frames[0]).toEqual({ t: 'sse.open', id: 'c1' })
    })
  }

  it('still refuses an agent node token, even with forged browser metadata and the cookie', async () => {
    const { b, frames } = bridge({ ...CHROME, [TOKEN_HEADER]: NODE_TOKEN })
    b.sub('c1', '/api/agent-chat/chat/stream')
    await settle(frames)
    expect(frames).toEqual([{ t: 'sse.end', id: 'c1', status: 403 }])
  })

  it('still refuses a cross-origin upgrade', async () => {
    for (const headers of [{ ...UPGRADE, origin: 'http://evil.test' }, { ...CHROME, origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' }]) {
      const { b, frames } = bridge(headers)
      b.sub('c1', '/api/agent-chat/chat/stream')
      await settle(frames)
      expect(frames).toEqual([{ t: 'sse.end', id: 'c1', status: 403 }])
    }
  })

  it('still refuses an upgrade with no UI session', async () => {
    const { cookie: _drop, ...noCookie } = CHROME
    const { b, frames } = bridge(noCookie)
    b.sub('c1', '/api/agent-chat/chat/stream')
    await settle(frames)
    expect(frames).toEqual([{ t: 'sse.end', id: 'c1', status: 403 }])
  })

  it('a node the board has not saved yet answers 404, then opens once it exists', async () => {
    const { b, frames } = bridge(UPGRADE)
    open.push(b)
    b.sub('n1', '/api/agent-chat/fresh/stream')
    await settle(frames)
    expect(frames).toEqual([{ t: 'sse.end', id: 'n1', status: 404 }])
    addNode('fresh')
    frames.length = 0
    b.sub('n1', '/api/agent-chat/fresh/stream')
    await settle(frames)
    expect(frames[0]).toEqual({ t: 'sse.open', id: 'n1' })
  })
})
