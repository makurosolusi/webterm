/**
 * Public entry point for the P4a inbox projection. `api.ts` should import from
 * here only.
 *
 * Integration contract:
 * - `buildInbox(db, projectId?, { now?, limit?, offset? })` returns
 *   `{ items, total, limit, offset }`; omit `projectId` for the cross-project view.
 * - `inboxCounts(db, projectId?, { now? })` returns category badge counts.
 * - Both are pure SELECTs: rendering never approves, retries, or mutates.
 */
export { buildInbox, inboxCounts } from './inbox'
export {
  INBOX_CATEGORIES,
  INBOX_CATEGORY_LABEL,
  InboxError,
} from './inboxModel'
export type {
  InboxCategory,
  InboxCounts,
  InboxItem,
  InboxKind,
  InboxOptions,
  InboxResult,
} from './inboxModel'
