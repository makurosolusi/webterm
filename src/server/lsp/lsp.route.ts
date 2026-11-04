// `/ws/lsp?workspace=<id>&language=typescript|python` — WebSocket <-> language-server bridge.
// One WS text frame = one JSON-RPC message. Reached only after index.ts ran `allowed()` and the
// human-channel Origin gate (wsOrigin.ts), same as /ws and /ws/browser. The server root is the
// workspace's stored cwd, never a client-supplied path.
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Workspace } from '../../shared/workspace'
import { isSafeWorkspaceId } from '../browser/profile.paths'
import { LSP_CLOSE, LSP_UNAVAILABLE } from './lsp.contract'
import { lspManager, type LspManager } from './lsp.manager'
import { isLspLanguage, type LspLanguage } from './lsp.resolve'

const wss = new WebSocketServer({ noServer: true })

/** Wire one accepted socket to the manager. Exported for tests (real `ws` sockets). */
export function bridgeLspSocket(sock: WebSocket, manager: LspManager, root: string, language: LspLanguage): void {
  const r = manager.attach(root, language, {
    send: (json) => { if (sock.readyState === sock.OPEN) sock.send(json) },
    close: (code, reason) => sock.close(code, reason),
  })
  if ('message' in r) {
    sock.send(JSON.stringify({ webterm: LSP_UNAVAILABLE, ...r }))
    sock.close(LSP_CLOSE.unavailable, 'unavailable')
    return
  }
  sock.on('message', (raw) => r.send(String(raw)))
  sock.on('close', () => r.detach())
}

export interface LspUpgradeDeps {
  workspace(id: string): Workspace | null
  manager?: LspManager
}

export function lspUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL, deps: LspUpgradeDeps): void {
  const id = url.searchParams.get('workspace')
  const language = url.searchParams.get('language') ?? 'typescript'
  const ws = isSafeWorkspaceId(id) ? deps.workspace(id) : null
  if (!ws?.cwd || !isLspLanguage(language)) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  const root = ws.cwd
  wss.handleUpgrade(req, socket, head, (sock) => bridgeLspSocket(sock, deps.manager ?? lspManager(), root, language))
}
