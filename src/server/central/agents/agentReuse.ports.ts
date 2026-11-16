// Production ports of the worker-reuse policy: live sessions, the user's focus, the browser runtime and the board's cables.
// Loaded lazily (like the node tools in registerAll) so importing the playbooks never boots sessions or the board runtime.
import type { Database } from 'bun:sqlite'
import type { BrowserState } from '../../../shared/browser.contract'
import { cableGrants } from '../../policy/policy.cable'
import { classifyBrowserNode, isInUse } from '../../browser/browser.idle'
import { ledgerAgentOfNode, storedBoards } from '../browserIdle.ports'
import { browserNodesOf } from '../tools/defs/browser.status'
import type { ReusePorts } from './agentReuse'

/**
 * `browserBusy` and `idleBrowsers` of the reuse policy, both answered by the shared idle classifier (browser/browser.idle.ts).
 * ponytail: a human using the page unfocused for <HUMAN_IDLE_MS is not seen (only the agent lease and the focus are).
 */
export function browserIdlePorts(src: { state(id: string): BrowserState | undefined; focused(): string | null; workspaceIdOf(nodeId: string): string | undefined }): Pick<ReusePorts, 'browserBusy' | 'idleBrowsers'> {
  const verdict = (db: Database, workspaceId: string, id: string) => classifyBrowserNode({ stateOf: src.state, focusedNode: src.focused, ...storedBoards(), agentOfNode: ledgerAgentOfNode(db) }, workspaceId, id)
  return {
    browserBusy(db, browserNodeId) {
      const ws = src.workspaceIdOf(browserNodeId)
      return ws === undefined ? false : isInUse(verdict(db, ws, browserNodeId))
    },
    idleBrowsers(db, projectId) {
      const found = browserNodesOf(db, projectId)
      return found.ok ? found.nodeIds.filter((id) => verdict(db, found.workspaceId, id).idle) : []
    },
  }
}

/** Builds the process-wide ports; resolved on first use. */
export async function productionReusePorts(): Promise<ReusePorts> {
  const [{ sessions }, { presence }, { getCanvasPush }, { activeBrowser }] = await Promise.all([
    import('../../sessions'), import('../../channels/channelPresence'), import('../../canvas/canvasPush.runtime'), import('../../browser/browser.state'),
  ])
  const canvas = getCanvasPush()
  const focused = (): string | null => presence.focusedNode()?.nodeId ?? null
  return {
    hasSession: (nodeId) => sessions.isLive(nodeId),
    focusedNode: focused,
    cabledBrowsers: (agentNodeId) => {
      const ws = canvas.workspaceOfNode(agentNodeId)
      return ws ? cableGrants([ws], agentNodeId).map((g) => g.scope.slice('node:'.length)) : []
    },
    ...browserIdlePorts({ state: (id) => activeBrowser()?.state(id), focused, workspaceIdOf: (id) => canvas.workspaceOfNode(id)?.id }),
    link(agentNodeId, browserNodeId) {
      const ws = canvas.workspaceOfNode(agentNodeId)
      if (!ws) return false
      const bridge = { id: `bridge-${agentNodeId}-${browserNodeId}`, source: agentNodeId, target: browserNodeId, kind: 'context' as const }
      return canvas.update({ workspaceId: ws.id, patches: [], bridgesAdd: [bridge] }).ok
    },
  }
}
