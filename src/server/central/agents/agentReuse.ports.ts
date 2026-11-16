// Production ports of the worker-reuse policy: live sessions, the user's focus, the browser runtime and the board's cables.
// Loaded lazily (like the node tools in registerAll) so importing the playbooks never boots sessions or the board runtime.
import { cableGrants } from '../../policy/policy.cable'
import { linkedPeerIds } from '../../contextLinkRoute'
import { browserNodesOf } from '../tools/defs/browser.status'
import { lookupWorkspace } from '../workspaceLookup'
import type { ReusePorts } from './agentReuse'

/** Builds the process-wide ports; resolved on first use. */
export async function productionReusePorts(): Promise<ReusePorts> {
  const [{ sessions }, { presence }, { getCanvasPush }, { activeBrowser }] = await Promise.all([
    import('../../sessions'), import('../../channels/channelPresence'), import('../../canvas/canvasPush.runtime'), import('../../browser/browser.state'),
  ])
  const canvas = getCanvasPush()
  const focused = (): string | null => presence.focusedNode()?.nodeId ?? null
  // The lease holder is the only activity signal the runtime exposes: an agent lease means someone drives it; a human
  // typing is caught by the focus check. ponytail: a human using the page unfocused for <HUMAN_IDLE_MS is not seen.
  const busy = (id: string): boolean => activeBrowser()?.state(id)?.lease === 'agent' || focused() === id
  return {
    hasSession: (nodeId) => sessions.isLive(nodeId),
    focusedNode: focused,
    cabledBrowsers: (agentNodeId) => {
      const ws = canvas.workspaceOfNode(agentNodeId)
      return ws ? cableGrants([ws], agentNodeId).map((g) => g.scope.slice('node:'.length)) : []
    },
    browserBusy: busy,
    idleBrowsers(db, projectId) {
      const found = browserNodesOf(db, projectId)
      const ws = found.ok ? lookupWorkspace(found.workspaceId) : null
      if (!found.ok || !ws || !Array.isArray((ws as { bridges?: unknown }).bridges)) return []
      return found.nodeIds.filter((id) => {
        const live = activeBrowser()?.state(id)?.live
        return live !== undefined && live !== 'discarded' && !busy(id) && linkedPeerIds(ws as never, id).size === 0
      })
    },
    link(agentNodeId, browserNodeId) {
      const ws = canvas.workspaceOfNode(agentNodeId)
      if (!ws) return false
      const bridge = { id: `bridge-${agentNodeId}-${browserNodeId}`, source: agentNodeId, target: browserNodeId, kind: 'context' as const }
      return canvas.update({ workspaceId: ws.id, patches: [], bridgesAdd: [bridge] }).ok
    },
  }
}
