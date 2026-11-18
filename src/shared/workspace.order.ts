// Persisted workspace order: `PUT /api/workspaces/order` (rail drag/keyboard reorder, any window).

/** Body of the reorder call: the COMPLETE new order, every stored workspace id exactly once. */
export interface WorkspaceOrderReq {
  ids: string[]
}

/** The `error` code of a refused reorder (HTTP 400). */
export const WORKSPACE_ORDER_ERROR = 'bad_order'

/** Why a reorder was refused: wrong shape, an id twice, an id no workspace has, or a stored workspace left out. */
export type WorkspaceOrderReason = 'shape' | 'duplicate' | 'unknown' | 'missing'

/** The 400 body of a refused reorder; ids are never echoed. */
export interface WorkspaceOrderError {
  error: typeof WORKSPACE_ORDER_ERROR
  reason: WorkspaceOrderReason
}
