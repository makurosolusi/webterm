// Sidebar/notification view of a workspace: `GET /api/workspaces?summary=1`. Full boards
// (viewport, layout, node geometry) come only from `GET /api/workspaces/:id`.

/** One workspace without its board geometry; `nodes` keeps only what a list row needs. */
export interface WorkspaceSummary {
  id: string
  name: string
  cwd?: string
  color?: string
  updatedAt: number
  nodes: Array<{ id: string; kind: string; name?: string; title?: string; agentId?: string }>
}

/** A page of summaries; `nextCursor` absent = last page. The cursor is opaque to the client. */
export interface WorkspaceSummaryPage {
  items: WorkspaceSummary[]
  nextCursor?: string
}
