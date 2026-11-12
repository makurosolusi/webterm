// chat.send / chat.config / chat.mode: Central drives an Agent Chat node (kind 'agentChat', the Claude Agent
// SDK chat) the way the user does from its composer and footer, with no browser open: send a message, pick
// model / effort / thinking, switch the permission mode. Terminal and Claude terminal nodes take canvas.type.
// The message text is never echoed in the output or the audit row: it may hold anything the user dictated.
import { isNodeName } from '../../../../shared/nodeNames'
import { isPermissionMode, type AgentPermissionMode } from '../../../../shared/workspace'
import { AGENT_CHAT_KIND } from '../../../../shared/agentChat.shape'
import type { ChatFail, ChatPort } from '../../../agentChat/agentChat.port'
import { AGENT_CHAT_EFFORTS } from '../../../agentChat/agentChat.controls'
import { beginDelegation, settleSend } from '../../work/workDelegation'
import { createWorkStore } from '../../work/workStore'
import type { ToolCtx, ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { obj, S } from '../../../capability/capability.schema'
import { type BoardNode, findBoardNode } from './canvas.type.defs'
import { isSafeId, MAX_ID, READ_TOOLS_FLAG } from './read.shared'

export interface ChatDefsDeps {
  /** Resolved per call so the chat runtime only loads when a tool runs (tests pass a fake). */
  chats(): ChatPort | Promise<ChatPort>
}

export const MAX_CHAT_TEXT = 8000
/** Chars of a model value; matches the chat config route (agentChat.controls.ts). */
const MAX_MODEL = 200
/** Modes Central may set; bypassPermissions stays the user's own switch. */
const CHAT_MODES: readonly AgentPermissionMode[] = ['manual', 'auto', 'acceptEdits', 'plan']

const fail = (code: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, code, ...(data ? { data } : {}) })
const portFail = (r: ChatFail, nodeId: string): ToolResult => fail(r.code, { nodeId, ...(r.hint ? { hint: r.hint } : {}) })
// Tab and newlines are ordinary text; other C0 bytes could hide text from the approval card.
export const plainText = (s: string): boolean => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)
const nodeRef = (v: unknown): boolean => isSafeId(v) || isNodeName(v, true)
const onlyKeys = (input: ToolInput, keys: readonly string[]): boolean => Object.keys(input).every((k) => keys.includes(k))

/** A resolved Agent Chat node. */
export type ChatTarget = Pick<BoardNode, 'workspaceId' | 'id' | 'name'>
type Target = ({ ok: true } & ChatTarget) | { ok: false; result: ToolResult }

/** The chat node `ref` on the project's board. */
function findChat(ctx: ToolCtx, projectId: string | undefined, ref: string): Target {
  const found = findBoardNode(ctx, projectId, ref)
  if (!found.ok) return found
  const { workspaceId, id, name, kind } = found.node
  if (kind !== AGENT_CHAT_KIND) {
    return { ok: false, result: fail('not_a_chat', { nodeId: id, kind: kind ?? null, hint: 'Only Agent Chat nodes take chat.*; type into terminal and Claude terminal nodes with canvas.type.' }) }
  }
  return { ok: true, workspaceId, id, name }
}

/** Records the delegation, then sends the text as the chat's next user message. */
export async function sendChat(ctx: ToolCtx, port: ChatPort, projectId: string | undefined, t: ChatTarget, text: string, taskId?: string): Promise<ToolResult> {
  const delegation = beginDelegation(createWorkStore(ctx.db, ctx.now), { projectId: String(projectId), nodeId: t.id, channel: 'chat', instruction: text, ...(taskId ? { taskId } : {}), conversationId: ctx.conversationId, ...(ctx.turnId ? { turnId: ctx.turnId } : {}) })
  if (!delegation.ok) return fail(delegation.code, delegation.data)
  const r = await settleSend(delegation, () => port.send(t.workspaceId, t.id, text), (sent) => (sent.ok ? null : sent.code))
  if (!r.ok) return portFail(r, t.id)
  return { ok: true, data: { sent: true, started: r.started, nodeId: t.id, name: t.name, taskId: delegation.taskId, assignmentId: delegation.assignmentId } }
}

function configShape(input: ToolInput): boolean {
  const { nodeId, model, effort, thinking } = input
  return onlyKeys(input, ['projectId', 'nodeId', 'model', 'effort', 'thinking']) && nodeRef(nodeId)
    && (model !== undefined || effort !== undefined || thinking !== undefined)
    && (model === undefined || model === null || (typeof model === 'string' && model.length >= 1 && model.length <= MAX_MODEL && plainText(model)))
    && (effort === undefined || effort === null || (AGENT_CHAT_EFFORTS as readonly unknown[]).includes(effort))
    && (thinking === undefined || typeof thinking === 'boolean')
}

const NODE_USAGE = '"nodeId":"<Agent Chat node id or name from node.list, e.g. Puffin>"'

/** Builds chat.send, chat.config and chat.mode bound to `deps.chats`. */
export function createChatDefs(deps: ChatDefsDeps): ToolDef[] {
  const send: ToolDef = {
    name: 'chat.send',
    summary: 'Send a message to an Agent Chat node, starting its session if needed. Approval: project mode.',
    tier: 'R2',
    flag: READ_TOOLS_FLAG,
    usage: `{"projectId":"<id>",${NODE_USAGE},"text":"<1-${MAX_CHAT_TEXT} chars>","taskId":"<optional task this continues>"}. Sends the text as the user's next message in that chat; `
      + 'started=true when its session had to be opened first. Only Agent Chat nodes; terminal and Claude terminal nodes take canvas.type. '
      + 'Tracked as a delegation: without taskId it continues the open card of the node or starts a new one. '
      + 'Read the reply with node.inspect.',
    input: obj({ nodeId: S.str(MAX_ID), text: S.str(MAX_CHAT_TEXT), taskId: S.str(MAX_ID) }, ['nodeId', 'text']),
    output: S.keys('sent', 'started', 'nodeId', 'name', 'taskId', 'assignmentId'),
    // Never the text: the audit row records which chat was messaged, not what was said.
    auditKeys: ['nodeId', 'started', 'assignmentId'],
    validate: (input) => (onlyKeys(input, ['projectId', 'nodeId', 'text', 'taskId']) && nodeRef(input.nodeId) && typeof input.text === 'string'
      && input.text.length >= 1 && input.text.length <= MAX_CHAT_TEXT && plainText(input.text) && (input.taskId === undefined || isSafeId(input.taskId)) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const t = findChat(ctx, projectId, String(input.nodeId))
      if (!t.ok) return t.result
      return sendChat(ctx, await deps.chats(), projectId, t, String(input.text), input.taskId as string | undefined)
    },
  }

  const config: ToolDef = {
    name: 'chat.config',
    summary: 'Set the model, effort or thinking of an Agent Chat node, like its footer pickers.',
    tier: 'R1',
    flag: READ_TOOLS_FLAG,
    usage: `{"projectId":"<id>",${NODE_USAGE},"model":"<optional>"|null,"effort":${AGENT_CHAT_EFFORTS.map((e) => `"${e}"`).join('|')}|null,`
      + '"thinking":<optional bool>}. Give at least one. model takes what the chat model picker lists: an alias such as "sonnet", "opus" '
      + 'or "haiku" (Claude Code resolves it to the current model of that family) or a full model id; null or "default" = Auto (model ladder). '
      + 'effort null = the model default. Applies live to an open session, else to its next start. Returns the resulting config.',
    input: obj({ nodeId: S.str(MAX_ID), model: { type: ['string', 'null'], maxLength: MAX_MODEL }, effort: { type: ['string', 'null'], enum: [...AGENT_CHAT_EFFORTS, null] }, thinking: S.bool() }, ['nodeId']),
    output: S.keys('config', 'nodeId', 'name'),
    auditKeys: ['nodeId', 'config'],
    validate: (input) => (configShape(input) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const t = findChat(ctx, projectId, String(input.nodeId))
      if (!t.ok) return t.result
      // The picker's Auto entry is `default`; the port stores "no explicit model" as null.
      const patch = {
        ...(input.model !== undefined ? { model: input.model === 'default' ? null : (input.model as string | null) } : {}),
        ...(input.effort !== undefined ? { effort: input.effort as string | null } : {}),
        ...(input.thinking !== undefined ? { thinking: input.thinking as boolean } : {}),
      }
      const r = await (await deps.chats()).configure(t.workspaceId, t.id, patch)
      if (!r.ok) return portFail(r, t.id)
      return { ok: true, data: { config: r.config, nodeId: t.id, name: t.name } }
    },
  }

  const mode: ToolDef = {
    name: 'chat.mode',
    summary: 'Switch the permission mode of an Agent Chat node (manual, auto, acceptEdits, plan). Approval: project mode.',
    tier: 'R2',
    flag: READ_TOOLS_FLAG,
    usage: `{"projectId":"<id>",${NODE_USAGE},"mode":${CHAT_MODES.map((m) => `"${m}"`).join('|')}}. manual = asks before tools (Claude Code's `
      + 'default), acceptEdits = file edits run without asking, plan = plans without editing, auto = Claude Code\'s auto mode. '
      + 'bypassPermissions is refused: only the user turns it on.',
    input: obj({ nodeId: S.str(MAX_ID), mode: S.str(32) }, ['nodeId', 'mode']),
    output: S.keys('permissionMode', 'nodeId', 'name'),
    auditKeys: ['nodeId', 'permissionMode'],
    validate: (input) => (onlyKeys(input, ['projectId', 'nodeId', 'mode']) && nodeRef(input.nodeId) && isPermissionMode(input.mode) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const t = findChat(ctx, projectId, String(input.nodeId))
      if (!t.ok) return t.result
      if (!CHAT_MODES.includes(input.mode as AgentPermissionMode)) {
        return fail('mode_refused', { nodeId: t.id, hint: 'Only the user can turn on bypass permissions, from the node footer.' })
      }
      const r = await (await deps.chats()).setMode(t.workspaceId, t.id, String(input.mode))
      if (!r.ok) return portFail(r, t.id)
      return { ok: true, data: { permissionMode: r.permissionMode, nodeId: t.id, name: t.name } }
    },
  }
  return [send, config, mode]
}
