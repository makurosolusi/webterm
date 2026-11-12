// canvas.type (R2): Central types into a terminal or Claude node of a project's board ("run npm test in
// Mango"), the same input path a human keystroke and the control API's node.prompt take (sessions.input).
// It can also press named keys (Escape, C-c, arrows...) first, e.g. to leave a TUI panel before typing.
// The typed text is never echoed in the output or the audit row: it may hold anything the user dictated.
import { AGENT_CHAT_KIND } from '../../../../shared/agentChat.shape'
import { isNodeName, withNodeNames } from '../../../../shared/nodeNames'
import { submitToNode, type SubmitOptions, type SubmitResult, type SubmitSessions } from '../../../agentSubmit'
import { MAX_PROMPT_CHARS } from '../../../control/controlTypes'
import { beginDelegation, settleSend } from '../../work/workDelegation'
import { createWorkStore } from '../../work/workStore'
import { projectWorkspace } from '../../workspaceLookup'
import type { ToolCtx, ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { obj, S } from '../../../capability/capability.schema'
import { liveAgentNodes } from './canvas.act.defs'
import { KEY_NAMES, keyBytes } from './canvas.type.keys'
import { isSafeId, MAX_ID, READ_TOOLS_FLAG } from './read.shared'

/** The Sessions calls this tool uses (tests pass a fake); submitting goes through `agentSubmit.ts`. */
export interface TypeSessions extends SubmitSessions { isLive(id: string): boolean }
export interface CanvasTypeDeps {
  /** Resolved per call so the PTY supervisor only boots when the tool runs. */
  sessions(): TypeSessions | Promise<TypeSessions>
  /** Pause between keys and text; tests pass a fake so they do not wait. */
  sleep?(ms: number): Promise<void>
  /** Screen renderer for the submit confirmation; tests pass a fake screen. */
  render?: SubmitOptions['render']
}

/** Pause after pressed keys before the text: ESC straight followed by `/` reads as Alt+/ in TUIs. */
export const KEY_SETTLE_MS = 150
const MAX_KEYS = 20
// setTimeout, not Bun.sleep: the defs also load under vitest's node runtime.
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_KEY_NAME = 16

const FIELDS = ['projectId', 'nodeId', 'text', 'keys', 'submit', 'taskId']
const TYPEABLE = new Set(['terminal', 'agent'])
const fail = (code: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, code, ...(data ? { data } : {}) })
// Tab and newlines are ordinary typing; ESC and other C0 bytes could drive the terminal or hide text from the approval card.
const plainText = (s: string): boolean => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)

function typeShape(input: ToolInput): boolean {
  const { nodeId, text, keys, submit, taskId } = input
  const textOk = text === undefined || (typeof text === 'string' && text.length >= 1 && text.length <= MAX_PROMPT_CHARS && plainText(text))
  const keysOk = keys === undefined || (Array.isArray(keys) && keys.length >= 1 && keys.length <= MAX_KEYS
    && keys.every((k) => typeof k === 'string' && keyBytes(k) !== undefined))
  return Object.keys(input).every((k) => FIELDS.includes(k)) && (isSafeId(nodeId) || isNodeName(nodeId, true))
    && textOk && keysOk && (text !== undefined || keys !== undefined) && (taskId === undefined || isSafeId(taskId))
    // Enter without text is keys:["Enter"]; submit only qualifies typed text.
    && (submit === undefined || (typeof submit === 'boolean' && (text !== undefined || submit === false)))
}

/** A node of a project's board, resolved from an id or a name. */
export interface BoardNode { workspaceId: string; id: string; name: string; kind: unknown }

/** The board node `ref` names (an exact id wins over a name, as in canvas.close). */
export function findBoardNode(ctx: ToolCtx, projectId: string | undefined, ref: string): { ok: true; node: BoardNode } | { ok: false; result: ToolResult } {
  const found = projectWorkspace(ctx.db, projectId)
  if (!found.ok) return { ok: false, result: fail(found.code) }
  const board = found.nodes as Array<{ id?: unknown; name?: unknown; kind?: unknown }>
  const named = withNodeNames(board.map((n) => ({ id: String(n.id), name: typeof n.name === 'string' ? n.name : undefined })))
  const hit = named.find((n) => n.id === ref) ?? named.find((n) => n.name.toLowerCase() === ref.toLowerCase())
  if (!hit) return { ok: false, result: fail('node_not_found', { nodeId: ref }) }
  return { ok: true, node: { workspaceId: found.workspaceId, id: hit.id, name: hit.name, kind: board.find((n) => String(n.id) === hit.id)?.kind } }
}

/** The running session of a typeable node; a spawned worker and a stopped session are refused. */
export async function liveSession(ctx: ToolCtx, deps: Pick<CanvasTypeDeps, 'sessions'>, projectId: string | undefined, nodeId: string): Promise<{ ok: true; sessions: TypeSessions } | { ok: false; result: ToolResult }> {
  // Same guard as canvas.close: a worker you spawned is driven through agent.*, not typed into.
  const agentRef = liveAgentNodes(ctx.db, String(projectId), [nodeId]).get(nodeId)
  if (agentRef) return { ok: false, result: fail('use_agent_tool', { nodeId, agentRef, hint: 'This is a worker you spawned: message it with agent.prompt or agent.relay.' }) }
  const sessions = await deps.sessions()
  if (sessions.isLive(nodeId)) return { ok: true, sessions }
  return { ok: false, result: fail('session_not_running', { nodeId, hint: 'Its session is not running. Ask the user to open or restart the node in webterm, then retry.' }) }
}

/** What Central should do next when a submit did not start. */
const NOT_SUBMITTED_HINT: Record<Exclude<SubmitResult, { ok: true }>['reason'], string> = {
  not_ready: 'Check the node with node.inspect (a dialog or a half-typed draft may be open), then retry or tell the user.',
  not_on_screen: 'Nothing was submitted. Retry once; if it fails again, tell the user.',
  not_started: 'The text may still be waiting in its input box: check with node.inspect and press keys:["Enter"] or tell the user. Do not retype it.',
}

/** What to type: keys go first, then the text. */
export interface TypeCall { node: BoardNode; text?: string; keys: string[]; submit: boolean; taskId?: string }

/** Types into a live node; text submitted to a Claude terminal is recorded as a delegation first. */
export async function typeInto(ctx: ToolCtx, projectId: string | undefined, sessions: TypeSessions, call: TypeCall, seams: Pick<CanvasTypeDeps, 'sleep' | 'render'> = {}): Promise<ToolResult> {
  const sleep = seams.sleep ?? wait
  const { node, text, keys, taskId } = call
  const submitted = text !== undefined && call.submit
  const delegation = submitted && node.kind === 'agent'
    ? beginDelegation(createWorkStore(ctx.db, ctx.now), { projectId: String(projectId), nodeId: node.id, channel: 'terminal', instruction: text, ...(taskId ? { taskId } : {}), conversationId: ctx.conversationId, ...(ctx.turnId ? { turnId: ctx.turnId } : {}) })
    : null
  if (delegation && !delegation.ok) return fail(delegation.code, delegation.data)
  const send = async (): Promise<SubmitResult | null> => {
    if (keys.length) sessions.input(node.id, keys.map((k) => keyBytes(k) ?? '').join(''))
    if (text === undefined) return null
    if (keys.length) await sleep(KEY_SETTLE_MS)
    if (!submitted) { sessions.input(node.id, text); return null }
    return submitToNode(sessions, node.id, text, { sleep, ...(seams.render ? { render: seams.render } : {}) })
  }
  const sent = delegation ? await settleSend(delegation, send, (r) => (r && !r.ok ? r.reason : null)) : await send()
  const tracking = delegation ? { taskId: delegation.taskId, assignmentId: delegation.assignmentId } : taskId ? { tracked: false } : {}
  if (sent && !sent.ok) {
    return fail(sent.reason, { nodeId: node.id, name: node.name, ...tracking, hint: `${sent.message} ${NOT_SUBMITTED_HINT[sent.reason]}` })
  }
  return { ok: true, data: { nodeId: node.id, name: node.name, submitted, length: text?.length ?? 0, keys, ...tracking } }
}

/** Builds canvas.type bound to `deps.sessions`. */
export function createCanvasTypeDefs(deps: CanvasTypeDeps): ToolDef[] {
  const type: ToolDef = {
    name: 'canvas.type',
    summary: 'Type text and/or press keys (Escape, Ctrl+C, arrows) in a terminal or Claude node; it is a real shell. Asks the user.',
    tier: 'R2',
    flag: READ_TOOLS_FLAG,
    usage: `{"projectId":"<id>","nodeId":"<node id or name from node.list, e.g. Mango>","text":"<optional, 1-${MAX_PROMPT_CHARS} chars>",`
      + `"keys":["<optional, 1-${MAX_KEYS} key names>"],"submit":<default true = press Enter after the text>,"taskId":"<optional task this continues>"}. Give text, keys or both; `
      + `keys are pressed first, then the text is typed. Key names (case-sensitive): ${KEY_NAMES.join(', ')} (C-c = Ctrl+C). `
      + 'To leave a TUI panel or menu press Escape first; C-c interrupts a running command. For Enter alone use keys:["Enter"]. '
      + 'Only terminal and Claude nodes with a running session. '
      + 'Text submitted to a Claude node is tracked as a delegation (new card unless taskId or an open card applies); plain shells are not. '
      + 'Workers you spawned take agent.prompt / agent.relay instead. Read the screen and result with node.inspect.',
    input: obj({ nodeId: S.str(MAX_ID), text: S.str(MAX_PROMPT_CHARS), keys: S.arr(S.str(MAX_KEY_NAME), MAX_KEYS), submit: S.bool(), taskId: S.str(MAX_ID) }, ['nodeId']),
    output: S.keys('nodeId', 'name', 'submitted', 'length', 'keys', 'taskId', 'assignmentId', 'tracked'),
    // Never the text: the audit row records what was typed into and which keys, not what was typed.
    auditKeys: ['nodeId', 'length', 'submitted', 'keys', 'assignmentId'],
    validate: (input) => (typeShape(input) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const found = findBoardNode(ctx, projectId, String(input.nodeId))
      if (!found.ok) return found.result
      const { node } = found
      if (node.kind === AGENT_CHAT_KIND) {
        return fail('use_chat_tool', { nodeId: node.id, hint: 'This is an Agent Chat node: send messages with chat.send and change its model with chat.config.' })
      }
      if (!TYPEABLE.has(String(node.kind))) return fail('not_a_terminal', { nodeId: node.id, kind: node.kind ?? null })
      const live = await liveSession(ctx, deps, projectId, node.id)
      if (!live.ok) return live.result
      return typeInto(ctx, projectId, live.sessions, {
        node, keys: (input.keys as string[] | undefined) ?? [], submit: input.submit !== false,
        ...(typeof input.text === 'string' ? { text: input.text } : {}), ...(typeof input.taskId === 'string' ? { taskId: input.taskId } : {}),
      }, deps)
    },
  }
  return [type]
}
