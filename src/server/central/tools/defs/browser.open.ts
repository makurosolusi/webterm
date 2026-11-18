// `browser_open` (R1): a browser node for Central's work. With `agentRef` it is opened beside a Central-started PTY agent and
// cabled to it, so the agent drives it with `webterm-browser` from its first command (playbook.web_research opens it right
// after the spawn); same core as the agent's own `webterm-browser open` (browser.agentOpen.ts): agent-control switch,
// MAX_LIVE gate, cable rules. Without `agentRef` it is a standalone node of the project's board that Central drives itself
// (browser_act). `profile` (name or id, any case) picks the logins; none = the board's Default. An idle central browser is
// reused only when it runs the SAME profile.
import { isSafeNodeId } from '../../../../shared/workspace'
import { getRow } from '../../../ledger/ledgerCore'
import { agentControlOn } from '../../../browser/browser.runtime.parts'
import { classifyBrowserNode } from '../../../browser/browser.idle'
import { AGENT_TERMINAL_STATES } from '../../contracts'
import { obj, S } from '../../../capability/capability.schema'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { type BrowserToolDeps, browserNodesOf, idlePortsOf } from './browser.status'
import { unknownProfile } from './browser.profile'

const KEYS = ['projectId', 'agentRef', 'nodeId', 'profile']
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/
const PROFILE_REF_MAX = 64

const shapeOk = (input: ToolInput): boolean => Object.keys(input).every((k) => KEYS.includes(k))
  && (input.agentRef === undefined || (typeof input.agentRef === 'string' && SAFE_ID.test(input.agentRef)))
  && (input.nodeId === undefined || isSafeNodeId(input.nodeId))
  && (input.profile === undefined || (typeof input.profile === 'string' && input.profile.trim() !== '' && input.profile.length <= PROFILE_REF_MAX))

/** Builds `browser_open`; only registered when the browser runtime can open nodes (beside an agent, or standalone). */
export function createBrowserOpenDef(deps: BrowserToolDeps): ToolDef {
  return {
    name: 'browser_open',
    summary: 'Open a browser node (own logins via profile): beside a pty agent you started, or alone for you.',
    tier: 'R1',
    enabled: agentControlOn,
    usage: '{"projectId":"<id>","profile":"<optional profile name or id>","agentRef":"<optional agentId>","nodeId":"<optional id for the new browser node>"}. With agentRef the browser is cabled to that pty agent, which then uses `webterm-browser navigate|snapshot|click` with no --node (tell it the node id); without it you get a browser on the board to drive with browser_act. profile = separate logins and cookies (an unknown name answers with the profiles that exist); omit it for the board\'s Default. An idle central browser on the same profile is reused.',
    input: obj({ agentRef: S.str(200), nodeId: S.str(64), profile: S.str(PROFILE_REF_MAX) }),
    output: S.keys('nodeId', 'agentId', 'agentNode', 'started', 'profile', 'reused'),
    auditKeys: ['nodeId', 'agentId', 'started', 'profile'],
    validate: (input) => (shapeOk(input) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const asked = typeof input.profile === 'string' ? input.profile.trim() : undefined
      const found = asked !== undefined || input.agentRef === undefined ? browserNodesOf(ctx.db, projectId) : null
      if (found && !found.ok) return { ok: false, code: found.code }
      const wanted = asked === undefined ? undefined : deps.profiles?.resolve(asked, found!.workspaceId)
      if (asked !== undefined && !wanted) return unknownProfile(asked, deps.profiles?.list(found!.workspaceId) ?? [], deps.profiles !== undefined)
      const nodeId = typeof input.nodeId === 'string' ? input.nodeId : `br-${crypto.randomUUID()}`
      const used = wanted ? { profile: wanted.name } : {}

      if (typeof input.agentRef === 'string') {
        const agentId = input.agentRef
        const row = getRow(ctx.db, 'SELECT runner, state, node_id FROM central_agents WHERE id = ? AND project_id = ?', agentId, projectId)
        if (!row) return { ok: false, code: 'agent_not_found' }
        if (row.runner !== 'pty' || (AGENT_TERMINAL_STATES as readonly string[]).includes(String(row.state))) return { ok: false, code: 'agent_not_active' }
        const agentNode = row.node_id === null ? `c-${agentId}` : String(row.node_id)
        const made = await deps.open!(agentNode, nodeId, wanted?.id)
        if (!made.ok) return made.code === 'profile_not_found' ? unknownProfile(asked ?? '', deps.profiles?.list(found?.ok ? found.workspaceId : '') ?? [], true) : { ok: false, code: made.code, data: { agentId, agentNode } }
        return { ok: true, data: { nodeId: made.nodeId ?? nodeId, agentId, agentNode, started: made.started, ...used } }
      }

      // Standalone: take an idle central browser on the SAME profile before adding one (the cap on live pages is shared).
      const ws = found as Extract<typeof found, { ok: true }>
      const profileId = wanted?.id ?? ws.workspaceId
      const ports = idlePortsOf(deps, ctx.db)
      const idle = ws.nodeIds.find((id) => classifyBrowserNode(ports, ws.workspaceId, id, profileId).idle)
      if (idle) return { ok: true, data: { nodeId: idle, started: true, reused: true, ...used } }
      if (!deps.openProject) return { ok: false, code: 'disabled' }
      const made = await deps.openProject(ws.workspaceId, nodeId, wanted?.id)
      if (!made.ok) return made.code === 'profile_not_found' ? unknownProfile(asked ?? '', deps.profiles?.list(ws.workspaceId) ?? [], true) : { ok: false, code: made.code }
      return { ok: true, data: { nodeId, started: true, ...used } }
    },
  }
}
