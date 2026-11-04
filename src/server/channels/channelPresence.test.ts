// Desktop -> Telegram forwarding: a notice only when every tab is away past the delay, the agent
// transitioned into done/waiting/blocked, and its workspace is not muted. Plus the presence routes.
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'

import type { SenseEvent } from '../events/eventModel'
import { createPresenceTracker, renderAgentNotice, startAgentForwarder } from './channelPresence'
import { FORWARDING_PATH, PRESENCE_PATH, handleChannelPresenceApi } from './channelPresenceHttp'
import type { EnqueueReplyInput } from './channelStore'

const MIN = 60_000

function setup(awayMinutes = 3) {
  const clock = { t: 0 }
  const presence = createPresenceTracker(() => clock.t)
  const sent: EnqueueReplyInput[] = []
  const store = {
    forwardAwayMinutes: awayMinutes,
    listBindings: () => [
      { chatId: '100', binding: { projectId: 'ws-1', role: 'owner' as const } },
      { chatId: '200', binding: { projectId: 'ws-2', role: 'owner' as const } },
    ],
    enqueueReply: (input: EnqueueReplyInput) => { sent.push(input); return 'queued' as const },
  }
  let emit: (e: SenseEvent) => void = () => {}
  let unsubscribed = false
  const stop = startAgentForwarder({
    store,
    presence,
    subscribe: (pattern, fn) => { expect(pattern).toBe('hook.*'); emit = fn; return () => { unsubscribed = true } },
    describe: (nodeId) => ({ label: `Agent ${nodeId}`, workspace: 'Alpha' }),
  })
  let seq = 0
  const hook = (status: string, nodeId = 'n1', workspaceId = 'ws-1'): void =>
    emit({ seq: ++seq, ts: clock.t, kind: 'hook.Stop', nodeId, workspaceId, payload: { status } } as SenseEvent)
  return { clock, presence, sent, store, hook, stop, unsubscribed: () => unsubscribed }
}

describe('agent forwarder', () => {
  it('stays silent while a tab was visible within the delay', () => {
    const s = setup()
    s.clock.t = 2 * MIN
    s.presence.note({ visible: true })
    s.clock.t = 4 * MIN // 2 min since the last visible ping
    s.hook('working')
    s.hook('done')
    expect(s.sent).toHaveLength(0)
  })

  it('forwards to the workspace chat only once every tab is away past the delay', () => {
    const s = setup()
    s.presence.note({ visible: true })
    s.clock.t = 3 * MIN
    s.presence.note({ visible: false }) // a hidden ping does not count as seen
    s.clock.t = 6 * MIN
    s.hook('working')
    s.hook('done')
    expect(s.sent).toEqual([expect.objectContaining({ channel: 'telegram', chatId: '100', text: 'Agent n1 finished in Alpha.' })])
    s.hook('done') // same status again: not news
    s.hook('waiting')
    expect(s.sent.map((r) => r.text)).toEqual(['Agent n1 finished in Alpha.', 'Agent n1 needs input in Alpha.'])
    expect(new Set(s.sent.map((r) => r.key)).size).toBe(2)
  })

  it('respects the per-workspace mute sent with the presence ping', () => {
    const s = setup()
    s.presence.note({ visible: false, muted: ['ws-1'] })
    s.clock.t = 10 * MIN
    s.hook('done', 'n1', 'ws-1')
    s.hook('blocked', 'n2', 'ws-2')
    expect(s.sent.map((r) => [r.chatId, r.text])).toEqual([['200', 'Agent n2 needs approval in Alpha.']])
  })

  it('a delay of 0 turns forwarding off, and stop unsubscribes', () => {
    const s = setup(0)
    s.clock.t = 60 * MIN
    s.hook('done')
    expect(s.sent).toHaveLength(0)
    s.stop()
    expect(s.unsubscribed()).toBe(true)
  })

  it('renders a generic notice when the node is unknown', () => {
    expect(renderAgentNotice('waiting', null)).toBe('An agent needs input.')
  })
})

function fakeReq(method: string, url: string, body?: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & { resume(): void }
  Object.assign(req, { method, url, headers: {}, resume: () => req })
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

function fakeRes(): ServerResponse & { done: Promise<{ status: number; body: string }> } {
  let resolve: (v: { status: number; body: string }) => void = () => {}
  const done = new Promise<{ status: number; body: string }>((r) => { resolve = r })
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: () => undefined,
    end(chunk?: string) { resolve({ status: res.statusCode, body: chunk ?? '' }) },
    done,
  }
  return res as unknown as ServerResponse & { done: typeof done }
}

describe('presence routes', () => {
  it('a visible ping resets away time and stores the mute list; bad bodies are 400', async () => {
    const clock = { t: 0 }
    const presence = createPresenceTracker(() => clock.t)
    const store = { forwardAwayMinutes: 3, setForwardAwayMinutes(n: number) { this.forwardAwayMinutes = n } }
    clock.t = 5 * MIN
    let res = fakeRes()
    expect(handleChannelPresenceApi(fakeReq('POST', PRESENCE_PATH, JSON.stringify({ visible: true, muted: ['ws-9'] })), res, { presence, store })).toBe(true)
    expect((await res.done).status).toBe(204)
    expect(presence.awayMs()).toBe(0)
    expect(presence.isMuted('ws-9')).toBe(true)
    res = fakeRes()
    handleChannelPresenceApi(fakeReq('POST', PRESENCE_PATH, JSON.stringify({ visible: 'yes' })), res, { presence, store })
    expect((await res.done).status).toBe(400)
    res = fakeRes()
    handleChannelPresenceApi(fakeReq('GET', PRESENCE_PATH), res, { presence, store })
    expect((await res.done).status).toBe(405)
  })

  it('reads and saves the forwarding delay, rejecting out-of-range values', async () => {
    const presence = createPresenceTracker()
    const store = { forwardAwayMinutes: 3, setForwardAwayMinutes(n: number) { this.forwardAwayMinutes = n } }
    let res = fakeRes()
    handleChannelPresenceApi(fakeReq('GET', FORWARDING_PATH), res, { presence, store })
    expect(JSON.parse((await res.done).body)).toEqual({ awayMinutes: 3 })
    res = fakeRes()
    handleChannelPresenceApi(fakeReq('PUT', FORWARDING_PATH, JSON.stringify({ awayMinutes: 10 })), res, { presence, store })
    expect(JSON.parse((await res.done).body)).toEqual({ awayMinutes: 10 })
    expect(store.forwardAwayMinutes).toBe(10)
    res = fakeRes()
    handleChannelPresenceApi(fakeReq('PUT', FORWARDING_PATH, JSON.stringify({ awayMinutes: -1 })), res, { presence, store })
    expect((await res.done).status).toBe(400)
    expect(handleChannelPresenceApi(fakeReq('GET', '/api/other'), fakeRes(), { presence, store })).toBe(false)
  })
})
