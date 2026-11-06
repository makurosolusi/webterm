// `GET stream` of the agent chat route: SSE replay of the session log after `?after=` /
// Last-Event-ID, then live, framed and heartbeated like centralChatSse.
import { DEFAULT_HEARTBEAT_MS, formatSseFrame } from '../central/chat/streamHub'
import { firstHeader } from '../httpHeaders'
import type { AgentChatEvent } from '../../shared/agentChat.wire'
import type { AgentChatPool } from './agentChat.pool'
import type { AgentChatSession } from './agentChat.session'
import { bad, fail, uint, type Ctx } from './agentChat.route.core'

/** SSE `event:` name of every agent chat frame. */
export const AGENT_CHAT_SSE_EVENT = 'agent-chat'

export function streamVerb(c: Ctx, deps: { pool: AgentChatPool; heartbeatMs?: number }, nodeId: string, s: AgentChatSession): true {
  const after = uint(firstHeader(c.req.headers['last-event-id']) ?? c.url.searchParams.get('after'))
  if (after === null) return fail(c, bad('after / Last-Event-ID must be a non-negative integer.'))
  const from = after ?? 0
  const res = c.res
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  const write = (e: AgentChatEvent): void => {
    if (!res.writableEnded) res.write(formatSseFrame({ kind: 'event', id: e.seq, event: AGENT_CHAT_SSE_EVENT, data: e }))
  }
  // seq restarts at 1 with the server; without this a page open across a restart drops every new event.
  s.resumeAfter(from)
  const replay = s.events(from)
  const oldest = replay[0]?.seq ?? Number.POSITIVE_INFINITY
  // The init the log cap dropped (the client needs its session id), then prompts still waiting for an
  // answer that the client's cursor already passed, then the regular replay.
  const init = deps.pool.lastInit(nodeId)
  if (init && init.seq > from && init.seq < oldest) write(init)
  const open = new Set(deps.pool.gate.pending(nodeId).map((r) => r.requestId))
  for (const e of s.events(0)) if (e.t === 'permission' && e.seq <= from && open.has(e.requestId)) write(e)
  for (const e of replay) write(e)
  const off = s.subscribe(write)
  const beat = setInterval(() => { if (!res.writableEnded) res.write(formatSseFrame({ kind: 'heartbeat' })) }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
  beat.unref?.() // never hold the process open for a heartbeat
  // Both res and req emit close on a disconnect; unsubscribe exactly once.
  let done = false
  const cleanup = (): void => { if (done) return; done = true; off(); clearInterval(beat) }
  res.once('close', cleanup)
  c.req.once('close', cleanup)
  return true
}
