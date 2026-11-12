// `browser_open` (R1): a browser node beside a Central-started PTY agent, cabled to it, so the agent drives it with
// `webterm-browser` from its first command (playbook.web_research opens it right after the spawn). Same core as the
// agent's own `webterm-browser open` (browser.agentOpen.ts): agent-control switch, MAX_LIVE gate, cable rules.
import { isSafeNodeId } from '../../../../shared/workspace'
import { getRow } from '../../../ledger/ledgerCore'
import { agentControlOn } from '../../../browser/browser.runtime.parts'
import { AGENT_TERMINAL_STATES } from '../../contracts'
import { obj, S } from '../../../capability/capability.schema'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import type { BrowserToolDeps } from './browser.status'

const KEYS = ['projectId', 'agentRef', 'nodeId']
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/

const shapeOk = (input: ToolInput): boolean => Object.keys(input).every((k) => KEYS.includes(k))
  && typeof input.agentRef === 'string' && SAFE_ID.test(input.agentRef) && (input.nodeId === undefined || isSafeNodeId(input.nodeId))

/** Builds `browser_open` over `open`; only registered when the browser runtime can open nodes. */
export function createBrowserOpenDef(open: NonNullable<BrowserToolDeps['open']>): ToolDef {
  return {
    name: 'browser_open',
    summary: 'Open a browser node beside a pty agent you started, cabled to it, so the agent can drive the page.',
    tier: 'R1',
    enabled: agentControlOn,
    usage: '{"projectId":"<id>","agentRef":"<agentId>","nodeId":"<optional id for the new browser node>"}. The agent then uses `webterm-browser navigate|snapshot|click` with no --node. Tell the agent the node id.',
    input: obj({ agentRef: S.str(200), nodeId: S.str(64) }, ['agentRef']),
    output: S.keys('nodeId', 'agentId', 'agentNode', 'started'),
    auditKeys: ['nodeId', 'agentId', 'started'],
    validate: (input) => (shapeOk(input) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const agentId = input.agentRef as string
      const row = getRow(ctx.db, 'SELECT runner, state, node_id FROM central_agents WHERE id = ? AND project_id = ?', agentId, projectId)
      if (!row) return { ok: false, code: 'agent_not_found' }
      if (row.runner !== 'pty' || (AGENT_TERMINAL_STATES as readonly string[]).includes(String(row.state))) return { ok: false, code: 'agent_not_active' }
      const agentNode = row.node_id === null ? `c-${agentId}` : String(row.node_id)
      const nodeId = typeof input.nodeId === 'string' ? input.nodeId : `br-${crypto.randomUUID()}`
      const made = await open(agentNode, nodeId)
      if (!made.ok) return { ok: false, code: made.code, data: { agentId, agentNode } }
      return { ok: true, data: { nodeId, agentId, agentNode, started: made.started } }
    },
  }
}
