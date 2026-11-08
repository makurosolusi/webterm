// Which PTY sessions a node holds: one per pane leaf of a split terminal, else the node id itself.
// Shared because every close path needs it, the client's (human close) and the server's (deleted
// workspace, Central closing nodes): a close that ends only the node id leaks every other pane.
import type { Pane } from './workspace'

/** Leaf ids of a pane tree, left to right. */
export function paneLeafIds(p: Pane): string[] {
  return 'id' in p ? [p.id] : [...paneLeafIds(p.a), ...paneLeafIds(p.b)]
}

/** Every session id a node holds: its pane leaves, or its own id when it has no panes. */
export function sessionIdsOf(panes: Pane | undefined, nodeId: string): string[] {
  return panes ? paneLeafIds(panes) : [nodeId]
}
