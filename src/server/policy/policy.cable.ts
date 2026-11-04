// Cable-as-grant (PLAN S2): an edge between an agent node and a browser node IS a `browser.*` grant for
// that one browser. Computed from the board on every check and never copied into a table, so wiring a
// cable grants at once and removing it revokes at once (feedback zero-config). Pure: vitest-safe.
import { BROWSER_KIND } from '../../shared/browser.contract'
import type { Workspace } from '../../shared/workspace'
import { findWorkspaceFor, linkedPeerIds } from '../contextLinkRoute'
import type { Grant } from './policy.model'

/** Live `browser.*` grants of `nodeId`, one per browser node wired to it. */
export function cableGrants(workspaces: readonly Workspace[], nodeId: string): Grant[] {
  const ws = findWorkspaceFor(workspaces as Workspace[], nodeId)
  if (!ws) return []
  const peers = linkedPeerIds(ws, nodeId)
  return ws.nodes
    .filter((n) => n.kind === BROWSER_KIND && peers.has(n.id))
    .map((n) => ({
      id: `cable:${nodeId}->${n.id}`, subject: `node:${nodeId}`, capability: 'browser.*', scope: `node:${n.id}`,
      effect: 'allow', expiresAt: null, origin: 'cable', createdBy: 'human-ui', createdAt: 0,
    }))
}
