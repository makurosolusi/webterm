// Agent chat node surface (/api/agent-chat/:nodeId/*) over the process pool (agentChat.runtime.ts),
// and the Claude node chat/terminal view switch (/api/claude-view/:nodeId, agentChat.view.ts).
// UI-only (route.uiOnly.ts): no agent shell or plain curl drives a chat, answers its permission
// prompts, changes its mode or flips its view.
import { agentChatRoute } from '../agentChat/agentChat.route'
import { agentChatPool } from '../agentChat/agentChat.runtime'
import { CLAUDE_VIEW_PATH, claudeViewRoute, isCentralWorkerNode, type ClaudeViewDeps } from '../agentChat/agentChat.view'
import type { ApiRoute } from './route.core'
import { uiOnly } from './route.uiOnly'

/** Real deps, imported on first switch: ../sessions boots the PTY supervisor. */
async function claudeViewDeps(): Promise<ClaudeViewDeps> {
  const [{ sessions }, { getCanvasPush }, { activeLedgerRuntime }, { probeTranscript }, launcher] = await Promise.all([
    import('../sessions'), import('../canvas/canvasPush.runtime'), import('../ledger/ledgerRuntimeState'),
    import('../transcriptPresence'), import('../claudeLauncher/claudeLauncher'),
  ])
  return {
    canvas: getCanvasPush(),
    pool: agentChatPool(),
    closeNodes: (nodes) => sessions.closeNodes(nodes),
    statusOf: (id) => sessions.statusOf(id),
    hasTranscript: (id) => probeTranscript(id) === 'present',
    // No ledger runtime = no Central, so no Central worker.
    isCentralWorker: (nodeId) => { const db = activeLedgerRuntime()?.db; return !!db && isCentralWorkerNode(db, nodeId) },
    launchLine: (profileId) => launcher.claudeLaunchLine(profileId ? launcher.nodeClaudeLaunch(profileId) : launcher.resolveClaudeLaunch()),
  }
}

export const agentChatRoutes: ApiRoute[] = [
  uiOnly({ name: 'agent-chat', match: (c) => c.path.startsWith('/api/agent-chat/'), handle: (c) => agentChatRoute(c, { pool: agentChatPool() }) }),
  uiOnly({ name: 'claude-view', match: (c) => c.path.startsWith(CLAUDE_VIEW_PATH), handle: (c) => claudeViewRoute(c, claudeViewDeps) }),
]
