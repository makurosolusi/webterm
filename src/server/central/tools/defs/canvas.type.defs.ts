// canvas.type (R2): Central types into a terminal or Claude node of a project's board ("run npm test in
// Mango"), the same input path a human keystroke and the control API's node.prompt take (sessions.input).
// It can also press named keys (Escape, C-c, arrows...) first, e.g. to leave a TUI panel before typing.
// The typed text is never echoed in the output or the audit row: it may hold anything the user dictated.
import { AGENT_CHAT_KIND } from '../../../../shared/agentChat.shape'
import { isNodeName, withNodeNames } from '../../../../shared/nodeNames'
import { MAX_PROMPT_CHARS } from '../../../control/controlTypes'
import { projectWorkspace } from '../../workspaceLookup'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { obj, S } from '../../../capability/capability.schema'
import { liveAgentNodes } from './canvas.act.defs'
import { KEY_NAMES, keyBytes } from './canvas.type.keys'
import { isSafeId, MAX_ID, READ_TOOLS_FLAG } from './read.shared'

/** The two Sessions calls this tool uses (tests pass a fake). */
export interface TypeSessions { isLive(id: string): boolean; input(id: string, data: string): void }
export interface CanvasTypeDeps {
  /** Resolved per call so the PTY supervisor only boots when the tool runs. */
  sessions(): TypeSessions | Promise<TypeSessions>
  /** Pause between keys and text; tests pass a fake so they do not wait. */
  sleep?(ms: number): Promise<void>
}

/** Pause after pressed keys before the text: ESC straight followed by `/` reads as Alt+/ in TUIs. */
export const KEY_SETTLE_MS = 150
const MAX_KEYS = 20
// setTimeout, not Bun.sleep: the defs also load under vitest's node runtime.
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_KEY_NAME = 16

const FIELDS = ['projectId', 'nodeId', 'text', 'keys', 'submit']
const TYPEABLE = new Set(['terminal', 'agent'])
const fail = (code: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, code, ...(data ? { data } : {}) })
// Tab and newlines are ordinary typing; ESC and other C0 bytes could drive the terminal or hide text from the approval card.
const plainText = (s: string): boolean => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)

function typeShape(input: ToolInput): boolean {
  const { nodeId, text, keys, submit } = input
  const textOk = text === undefined || (typeof text === 'string' && text.length >= 1 && text.length <= MAX_PROMPT_CHARS && plainText(text))
  const keysOk = keys === undefined || (Array.isArray(keys) && keys.length >= 1 && keys.length <= MAX_KEYS
    && keys.every((k) => typeof k === 'string' && keyBytes(k) !== undefined))
  return Object.keys(input).every((k) => FIELDS.includes(k)) && (isSafeId(nodeId) || isNodeName(nodeId, true))
    && textOk && keysOk && (text !== undefined || keys !== undefined)
    // Enter without text is keys:["Enter"]; submit only qualifies typed text.
    && (submit === undefined || (typeof submit === 'boolean' && (text !== undefined || submit === false)))
}

/** Builds canvas.type bound to `deps.sessions`. */
export function createCanvasTypeDefs(deps: CanvasTypeDeps): ToolDef[] {
  const type: ToolDef = {
    name: 'canvas.type',
    summary: 'Type text and/or press keys (Escape, Ctrl+C, arrows) in a terminal or Claude node; it is a real shell. Asks the user.',
    tier: 'R2',
    flag: READ_TOOLS_FLAG,
    usage: `{"projectId":"<id>","nodeId":"<node id or name from node.list, e.g. Mango>","text":"<optional, 1-${MAX_PROMPT_CHARS} chars>",`
      + `"keys":["<optional, 1-${MAX_KEYS} key names>"],"submit":<default true = press Enter after the text>}. Give text, keys or both; `
      + `keys are pressed first, then the text is typed. Key names (case-sensitive): ${KEY_NAMES.join(', ')} (C-c = Ctrl+C). `
      + 'To leave a TUI panel or menu press Escape first; C-c interrupts a running command. For Enter alone use keys:["Enter"]. '
      + 'Only terminal and Claude nodes with a running session. '
      + 'Workers you spawned take agent.prompt / agent.relay instead. Read the screen and result with node.inspect.',
    input: obj({ nodeId: S.str(MAX_ID), text: S.str(MAX_PROMPT_CHARS), keys: S.arr(S.str(MAX_KEY_NAME), MAX_KEYS), submit: S.bool() }, ['nodeId']),
    output: S.keys('nodeId', 'name', 'submitted', 'length', 'keys'),
    // Never the text: the audit row records what was typed into and which keys, not what was typed.
    auditKeys: ['nodeId', 'length', 'submitted', 'keys'],
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
      if (kind === AGENT_CHAT_KIND) {
        return fail('use_chat_tool', { nodeId: hit.id, hint: 'This is an Agent Chat node: send messages with chat.send and change its model with chat.config.' })
      }
      if (!TYPEABLE.has(String(kind))) return fail('not_a_terminal', { nodeId: hit.id, kind: kind ?? null })
      // Same guard as canvas.close: a worker you spawned is driven through agent.*, not typed into.
      const agentRef = liveAgentNodes(ctx.db, String(projectId), [hit.id]).get(hit.id)
      if (agentRef) return fail('use_agent_tool', { nodeId: hit.id, agentRef, hint: 'This is a worker you spawned: message it with agent.prompt or agent.relay.' })
      const sessions = await deps.sessions()
      if (!sessions.isLive(hit.id)) {
        return fail('session_not_running', { nodeId: hit.id, hint: 'Its session is not running. Ask the user to open or restart the node in webterm, then retry.' })
      }
      const keys = (input.keys as string[] | undefined) ?? []
      const text = typeof input.text === 'string' ? input.text : undefined
      if (keys.length) sessions.input(hit.id, keys.map((k) => keyBytes(k) ?? '').join(''))
      const submitted = text !== undefined && input.submit !== false
      if (text !== undefined) {
        if (keys.length) await (deps.sleep ?? wait)(KEY_SETTLE_MS)
        sessions.input(hit.id, submitted ? `${text}\r` : text)
      }
      return { ok: true, data: { nodeId: hit.id, name: hit.name, submitted, length: text?.length ?? 0, keys } }
    },
  }
  return [type]
}
