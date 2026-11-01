// GET /api/context-link: read-only context sharing between linked nodes. Dipisah dari `api.ts`
// supaya file route utama tetap di bawah budget.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CONTEXT_LINK_VERBS, type ContextLinkVerb, renderForRequester } from './contextLink'
import { nodeTokenMismatch, requesterNodeId } from './agentStatusApi'
import { isSafeNodeId } from '../shared/workspace'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/** Returns true when it handled the request; false lets `api.ts` continue routing. */
export async function contextLinkRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  if (url.pathname !== '/api/context-link' || req.method !== 'GET') return false
  // `node` yang ADA tapi tidak aman ditolak jujur, bukan diteruskan: id itu menjadi kunci
  // `findWorkspaceFor`, dan menerimanya sebagai string bebas berarti route ini punya domain
  // input yang berbeda dari WebSocket.
  const nodeParam = url.searchParams.get('node')
  if (nodeParam !== null && !isSafeNodeId(nodeParam)) {
    sendJson(res, 400, { error: 'invalid node' })
    return true
  }
  const requester = nodeParam || ''
  // Token node hanya boleh membaca konteks node-nya sendiri; root/tanpa token tetap lama.
  if (nodeTokenMismatch(requesterNodeId(req), requester)) {
    sendJson(res, 403, { error: 'node token does not match node' })
    return true
  }
  const raw = url.searchParams.get('verb') || 'list'
  const verb = (CONTEXT_LINK_VERBS as string[]).includes(raw) ? (raw as ContextLinkVerb) : 'list'
  const want = url.searchParams.get('want') || undefined
  const n = url.searchParams.get('n') || undefined
  const text = await renderForRequester(requester, verb, { node: want, n })
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(text)
  return true
}
