// Control verbs of the agent chat route: `GET catalog` ("/" menu), `GET models`, `POST config`
// (model / effort / thinking), `GET sessions` (past conversations of the node's cwd), `POST resume`,
// `POST new`. Catalog and models open the node's Query without a turn when needed (pool cap and
// session lock respected); when that is refused or fails they answer 409 / 503 with a fallback list.
import { listSessions as sdkListSessions, type ListSessionsOptions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_CHAT_FALLBACK_COMMANDS } from '../../shared/agentChat.wire'
import { createLogger } from '../logs'
import { json } from '../routes/route.core'
import { AGENT_CHAT_SESSIONS_MAX, parseConfigPatch, sessionSummaries, toCommand, toModel } from './agentChat.controls'
import { AGENT_CHAT_BUSY_SWITCH_REASON, type AgentChatPool } from './agentChat.pool'
import type { AgentChatSession } from './agentChat.session'
import { bad, fail, ok, readObject, type Ctx } from './agentChat.route.core'

const log = createLogger('agent-chat')

export const CONTROL_VERBS: Record<string, 'GET' | 'POST'> = { catalog: 'GET', models: 'GET', sessions: 'GET', config: 'POST', resume: 'POST', new: 'POST' }
/** A Claude session id as the CLI writes it (UUID); also keeps path characters out of the SDK lookup. */
const SESSION_ID = /^[0-9a-zA-Z-]{1,100}$/

export type ListSessions = (o: ListSessionsOptions) => Promise<SDKSessionInfo[]>
export interface ControlDeps { pool: AgentChatPool; listSessions?: ListSessions }

const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err)

async function sessions(c: Ctx, deps: ControlDeps, nodeId: string): Promise<true> {
  const dir = deps.pool.cwd(nodeId) as string
  try {
    const list = await (deps.listSessions ?? sdkListSessions)({ dir, limit: AGENT_CHAT_SESSIONS_MAX })
    json(c.res, 200, { sessions: sessionSummaries(list, deps.pool.sessionId(nodeId)) })
  } catch (err) {
    log.error('agent_chat.sessions_failed', 'agent chat session list failed', { ids: { nodeId }, operation: 'sessions', error: errorName(err) })
    fail(c, { status: 502, error: 'sessions_unreadable', reason: `The past conversations of ${dir} could not be read.` })
  }
  return true
}

export async function controlVerb(c: Ctx, deps: ControlDeps, nodeId: string, verb: string, s: AgentChatSession): Promise<true> {
  if (verb === 'catalog' || verb === 'models') {
    const r = verb === 'catalog'
      ? await deps.pool.control(nodeId, async (q) => ({ commands: (await q.supportedCommands()).map(toCommand) }))
      : await deps.pool.control(nodeId, async (q) => ({ models: (await q.supportedModels()).map(toModel) }))
    if (r?.ok) { json(c.res, 200, r.value); return true }
    const reason = r?.reason ?? 'No agent chat node with this id.'
    if (r) log.warn('agent_chat.control_refused', 'agent chat control request refused', { ids: { nodeId }, operation: verb, status: r.status })
    json(c.res, r?.status ?? 404, { error: r?.status === 409 ? 'unavailable' : 'claude_unavailable', reason, ...(verb === 'catalog' ? { commands: AGENT_CHAT_FALLBACK_COMMANDS } : { models: [] }) })
    return true
  }
  if (verb === 'sessions') return sessions(c, deps, nodeId)
  const read = await readObject(c)
  if ('fail' in read) return fail(c, read.fail)
  if (verb === 'config') {
    const p = parseConfigPatch(read.body)
    if ('reason' in p) return fail(c, bad(p.reason))
    try {
      await s.setConfig(p.patch)
    } catch (err) {
      log.error('agent_chat.config_failed', 'agent chat config change failed', { ids: { nodeId }, operation: 'config', error: errorName(err) })
      return fail(c, { status: 502, error: 'config_failed', reason: err instanceof Error ? err.message : String(err) })
    }
    return ok(c)
  }
  let target: string | undefined
  if (verb === 'resume') {
    const id = read.body.sessionId
    if (typeof id !== 'string' || !SESSION_ID.test(id)) return fail(c, bad('sessionId must be a Claude session id.'))
    target = id
  }
  const r = deps.pool.switchTo(nodeId, target)
  // `busy` lets the client say why without echoing the body (agentChatErrorMessage).
  if (r && !r.ok) return fail(c, { status: r.status, error: r.reason === AGENT_CHAT_BUSY_SWITCH_REASON ? 'busy' : 'session_locked', reason: r.reason })
  return ok(c)
}
