// HTTP shapes of the unified inbox, mounted by `approvalHumanApi.ts` under `/api/approvals/inbox`
// so every action inherits its UI-only gate (no agent credential, webterm page only):
//   GET  /api/approvals/inbox[?projectId=&limit=&cursor=] -> { items, nextCursor }
//        (keyset pages of open items; pass nextCursor back as cursor until it is null)
//   POST /api/approvals/inbox/act   { id, action }   -> 200 { id, resolution } | 4xx { error }
//   POST /api/approvals/inbox/batch { ids, action }  -> 200 { results: [{ id, status, body }] }
// `action` = { type: approve | deny | edit | reply | ignore | snooze | always, args?, text?, until? }.
import { actOnItem, actOnItems, BATCH_MAX, type ActResult, type InboxActDeps } from './inboxActions'
import type { InboxAction } from './inboxItemModel'
import { InboxCursorError } from './inboxCursor'
import { INBOX_PAGE_MAX, pageInboxItems } from './inboxItemStore'

const ID_MAX = 200
/** Batch = the same verdict on similar items; `always` and `edit`/`reply` are per item by nature. */
const BATCH_ACTIONS = new Set(['approve', 'deny', 'ignore', 'snooze'])

function parseAction(raw: unknown): InboxAction | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const a = raw as Record<string, unknown>
  switch (a.type) {
    case 'approve': return { type: 'approve', ...(typeof a.scope === 'string' ? { scope: a.scope } : {}) }
    case 'ignore': case 'always': return { type: a.type }
    case 'deny': return { type: 'deny', ...(typeof a.reason === 'string' ? { reason: a.reason } : {}) }
    case 'edit': return 'args' in a ? { type: 'edit', args: a.args } : null
    case 'reply': return typeof a.text === 'string' ? { type: 'reply', text: a.text } : null
    case 'snooze': return typeof a.until === 'number' ? { type: 'snooze', until: a.until } : null
    default: return null
  }
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= ID_MAX

export function inboxListRoute(deps: Pick<InboxActDeps, 'ctx'>, url: URL): ActResult {
  const projectId = url.searchParams.get('projectId')
  if (projectId !== null && !isId(projectId)) return { status: 400, body: { error: 'invalid_project_id' } }
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? INBOX_PAGE_MAX : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > INBOX_PAGE_MAX) {
    return { status: 400, body: { error: 'invalid_limit', detail: `1..${INBOX_PAGE_MAX}` } }
  }
  const cursor = url.searchParams.get('cursor')
  try {
    const page = pageInboxItems(deps.ctx, { limit, ...(projectId === null ? {} : { projectId }), ...(cursor === null ? {} : { cursor }) })
    return { status: 200, body: { items: page.items, nextCursor: page.nextCursor } }
  } catch (err) {
    if (err instanceof InboxCursorError) return { status: 400, body: { error: 'invalid_cursor', detail: err.message } }
    throw new Error(`inbox list failed (projectId=${projectId ?? 'all'})`, { cause: err })
  }
}

export async function inboxActRoute(deps: InboxActDeps, body: Record<string, unknown>): Promise<ActResult> {
  const action = parseAction(body.action)
  if (!isId(body.id)) return { status: 400, body: { error: 'invalid_id' } }
  if (!action) return { status: 400, body: { error: 'invalid_action' } }
  return actOnItem(deps, body.id, action)
}

export async function inboxBatchRoute(deps: InboxActDeps, body: Record<string, unknown>): Promise<ActResult> {
  const action = parseAction(body.action)
  const ids = body.ids
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > BATCH_MAX || !ids.every(isId)) {
    return { status: 400, body: { error: 'invalid_ids', detail: `1..${BATCH_MAX} item ids` } }
  }
  if (!action || !BATCH_ACTIONS.has(action.type)) return { status: 400, body: { error: 'invalid_action', detail: 'batch: approve, deny, ignore or snooze' } }
  return { status: 200, body: { results: await actOnItems(deps, [...new Set(ids)], action) } }
}
