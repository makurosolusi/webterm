// Types and constants shared by the JSON route modules (memory, orchestrator, inbox, central,
// channel bindings, approvals), so each route file stops redefining them.

/** Pure route outcome: the caller serialises `body` with `status`. */
export type RouteResult = { status: number; body: unknown }

/** 503 returned by every ledger-backed route while the ledger flag is off. */
export const LEDGER_OFF: RouteResult = { status: 503, body: { error: 'ledger_off' } }

/** Upper bound (characters) for a project id and the id-like fields that share its budget. */
export const MAX_PROJECT_ID = 200
