// Sidebar summary of a workspace + its opaque page cursor (`GET /api/workspaces?summary=1`).
import type { Workspace } from '../shared/workspace'
import type { WorkspaceSummary } from '../shared/workspace.summary'

/** Page size bounds for the summary list. */
export const SUMMARY_LIMIT = { min: 1, max: 200, default: 50 } as const

/** The list-row view of a board: no viewport, layout, bridges or node geometry. */
export function toSummary(ws: Workspace): WorkspaceSummary {
  return {
    id: ws.id, name: ws.name, cwd: ws.cwd, color: ws.color, updatedAt: ws.updatedAt,
    nodes: ws.nodes.map((n) => ({ id: n.id, kind: n.kind, title: n.title, agentId: n.agentId })),
  }
}

/** Keyset position after `ws` (`updated_at DESC, id DESC`), base64url so clients treat it as opaque. */
export const encodeSummaryCursor = (ws: Pick<WorkspaceSummary, 'id' | 'updatedAt'>): string =>
  Buffer.from(JSON.stringify([ws.updatedAt, ws.id])).toString('base64url')

/** The keyset position of a cursor, or `null` when it is not one this server minted. */
export function decodeSummaryCursor(cursor: string): { updatedAt: number; id: string } | null {
  let v: unknown
  try {
    v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    return null // not base64url JSON: a forged or truncated cursor, answered 400 by the route
  }
  if (!Array.isArray(v) || v.length !== 2) return null
  const [updatedAt, id] = v as unknown[]
  return Number.isSafeInteger(updatedAt) && typeof id === 'string' ? { updatedAt: updatedAt as number, id } : null
}

/** `?limit=` -> a page size in bounds; absent = default, anything else unusable = `null` (400). */
export function parseSummaryLimit(raw: string | null): number | null {
  if (raw === null) return SUMMARY_LIMIT.default
  const n = Number(raw)
  return Number.isInteger(n) && n >= SUMMARY_LIMIT.min && n <= SUMMARY_LIMIT.max ? n : null
}
