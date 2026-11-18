// `PUT /api/workspaces/order`: the one write path of the persisted workspace order. Validates the body,
// stores through `Db.reorder` (atomic), tells every open window (`t:'workspaces'` with the new order) so
// other devices follow, and answers the full list in the new order.
import type { WorkspaceOrderError } from '../shared/workspace.order'
import { WORKSPACE_ORDER_ERROR } from '../shared/workspace.order'
import type { Db } from './db'
import { workspaceLog } from './workspacesLog'

const badOrder = (reason: WorkspaceOrderError['reason']): { status: number; body: WorkspaceOrderError } =>
  ({ status: 400, body: { error: WORKSPACE_ORDER_ERROR, reason } })

/** Apply `{ ids }`: 200 + the ordered list, or 400 `bad_order` with the reason (shape, duplicate, unknown, missing). */
export async function orderHttp(store: Db, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const ids = body.ids
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string' && id !== '')) return badOrder('shape')
  const r = store.reorder(ids)
  if (!r.ok) return badOrder(r.reason)
  const list = store.list()
  try {
    const { broadcastUi } = await import('./canvas/canvasPush.runtime')
    broadcastUi({ t: 'workspaces', order: list.map((w) => w.id) })
  } catch (err) {
    workspaceLog.sideEffectFailed('order broadcast', 'order', err) // stored already: a missed push must not fail the save
  }
  return { status: 200, body: list }
}
