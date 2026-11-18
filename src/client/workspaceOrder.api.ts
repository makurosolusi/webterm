// Client call for the persisted workspace order (`PUT /api/workspaces/order`, see shared/workspace.order.ts).
import type { Workspace } from '../shared/workspace'
import type { WorkspaceOrderReq } from '../shared/workspace.order'

/** `: error (reason)` of a refused call, when the server sent them; empty otherwise. */
async function refusal(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => undefined) // non-JSON error body: the status alone is reported
  if (!body || typeof body !== 'object') return ''
  const { error, reason } = body as { error?: unknown; reason?: unknown }
  return typeof error === 'string' ? `: ${error}${typeof reason === 'string' ? ` (${reason})` : ''}` : ''
}

/** Save the complete new order; resolves the workspaces in that order. Throws with the status and the server's code on refusal. */
export async function putWorkspaceOrder(ids: readonly string[]): Promise<Workspace[]> {
  const req: WorkspaceOrderReq = { ids: [...ids] }
  const res = await fetch('/api/workspaces/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) throw new Error(`PUT /api/workspaces/order -> ${res.status}${await refusal(res)}`)
  return res.json() as Promise<Workspace[]>
}
