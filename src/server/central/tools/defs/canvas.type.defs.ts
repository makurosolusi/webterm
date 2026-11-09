// canvas.type (R2): Central types into a terminal or Claude node of a project's board ("run npm test in
// Mango"), the same input path a human keystroke and the control API's node.prompt take (sessions.input).
// The typed text is never echoed in the output or the audit row: it may hold anything the user dictated.
import { isNodeName, withNodeNames } from '../../../../shared/nodeNames'
import { MAX_PROMPT_CHARS } from '../../../control/controlTypes'
import { projectWorkspace } from '../../workspaceLookup'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { obj, S } from '../../../capability/capability.schema'
import { liveAgentNodes } from './canvas.act.defs'
import { isSafeId, MAX_ID, READ_TOOLS_FLAG } from './read.shared'

/** The two Sessions calls this tool uses (tests pass a fake). */
export interface TypeSessions { isLive(id: string): boolean; input(id: string, data: string): void }
export interface CanvasTypeDeps {
  /** Resolved per call so the PTY supervisor only boots when the tool runs. */
  sessions(): TypeSessions | Promise<TypeSessions>
}

const KEYS = ['projectId', 'nodeId', 'text', 'submit']
const TYPEABLE = new Set(['terminal', 'agent'])
const fail = (code: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, code, ...(data ? { data } : {}) })
// Tab and newlines are ordinary typing; ESC and other C0 bytes could drive the terminal or hide text from the approval card.
const plainText = (s: string): boolean => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)

function typeShape(input: ToolInput): boolean {
  const { nodeId, text, submit } = input
  return Object.keys(input).every((k) => KEYS.includes(k)) && (isSafeId(nodeId) || isNodeName(nodeId, true))
    && typeof text === 'string' && text.length >= 1 && text.length <= MAX_PROMPT_CHARS && plainText(text)
    && (submit === undefined || typeof submit === 'boolean')
}

/** Builds canvas.type bound to `deps.sessions`. */
export function createCanvasTypeDefs(deps: CanvasTypeDeps): ToolDef[] {
  const type: ToolDef = {
    name: 'canvas.type',
    summary: 'Type text into a terminal or Claude node of a project canvas, then Enter; it runs in a real shell. Asks the user.',
    tier: 'R2',
    flag: READ_TOOLS_FLAG,
    usage: `{"projectId":"<id>","nodeId":"<node id or name from node.list, e.g. Mango>","text":"<1-${MAX_PROMPT_CHARS} chars>",`
      + '"submit":<default true = press Enter after>}. Only terminal and Claude nodes with a running session. '
      + 'Workers you spawned take agent.prompt / agent.relay instead. Read the result with node.read.',
    input: obj({ nodeId: S.str(MAX_ID), text: S.str(MAX_PROMPT_CHARS), submit: S.bool() }, ['nodeId', 'text']),
    output: S.keys('nodeId', 'name', 'submitted', 'length'),
    // Never the text: the audit row records what was typed into, not what.
    auditKeys: ['nodeId', 'length', 'submitted'],
    validate: (input) => (typeShape(input) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const found = projectWorkspace(ctx.db, projectId)
      if (!found.ok) return fail(found.code)
      const board = found.nodes as Array<{ id?: unknown; name?: unknown; kind?: unknown }>
      const named = withNodeNames(board.map((n) => ({ id: String(n.id), name: typeof n.name === 'string' ? n.name : undefined })))
      const ref = String(input.nodeId)
      // An exact id wins over a name, as in canvas.close.
      const hit = named.find((n) => n.id === ref) ?? named.find((n) => n.name.toLowerCase() === ref.toLowerCase())
      if (!hit) return fail('node_not_found', { nodeId: ref })
      const kind = board.find((n) => String(n.id) === hit.id)?.kind
      if (!TYPEABLE.has(String(kind))) return fail('not_a_terminal', { nodeId: hit.id, kind: kind ?? null })
      // Same guard as canvas.close: a worker you spawned is driven through agent.*, not typed into.
      const agentRef = liveAgentNodes(ctx.db, String(projectId), [hit.id]).get(hit.id)
      if (agentRef) return fail('use_agent_tool', { nodeId: hit.id, agentRef, hint: 'This is a worker you spawned: message it with agent.prompt or agent.relay.' })
      const sessions = await deps.sessions()
      if (!sessions.isLive(hit.id)) {
        return fail('session_not_running', { nodeId: hit.id, hint: 'Its session is not running. Ask the user to open or restart the node in webterm, then retry.' })
      }
      const text = String(input.text)
      const submitted = input.submit !== false
      sessions.input(hit.id, submitted ? `${text}\r` : text)
      return { ok: true, data: { nodeId: hit.id, name: hit.name, submitted, length: text.length } }
    },
  }
  return [type]
}
