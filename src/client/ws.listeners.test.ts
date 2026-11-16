// Status channel of the shared socket: reason passthrough and the connect snapshot's unread rule.
import { afterEach, describe, expect, it } from 'vitest'
import { dispatchBroadcast, getStatus, getStatusReason, subscribeAct, subscribeNet, subscribeStatus } from './ws.listeners'
import { clearUnread, unreadIds } from './unread'

// test-only ids
const IDS = ['r1', 'r2', 'snap-new', 'snap-changed']
afterEach(() => {
  for (const id of IDS) { dispatchBroadcast({ t: 'status', id }); clearUnread(id) }
})

describe('status reason', () => {
  it('keeps reason/detail with the status and hands it to listeners', () => {
    const heard: unknown[] = []
    const off = subscribeStatus((id, s, r) => heard.push([id, s, r]))
    dispatchBroadcast({ t: 'status', id: 'r1', status: 'blocked', reason: 'permission', detail: 'Bash' })
    off()
    expect(getStatusReason('r1')).toEqual({ reason: 'permission', detail: 'Bash' })
    expect(heard).toEqual([['r1', 'blocked', { reason: 'permission', detail: 'Bash' }]])
  })

  it('a later status without a reason drops the old one, and so does the sweep', () => {
    dispatchBroadcast({ t: 'status', id: 'r2', status: 'blocked', reason: 'permission' })
    dispatchBroadcast({ t: 'status', id: 'r2', status: 'working' })
    expect(getStatusReason('r2')).toBeUndefined()
    dispatchBroadcast({ t: 'status', id: 'r2', status: 'failed', reason: 'error' })
    dispatchBroadcast({ t: 'status', id: 'r2' })
    expect(getStatusReason('r2')).toBeUndefined()
    expect(getStatus('r2')).toBeUndefined()
  })
})

describe('connect snapshot', () => {
  it('a status this tab never knew (reload) marks nothing unread', () => {
    dispatchBroadcast({ t: 'status', id: 'snap-new', status: 'waiting', snapshot: true })
    expect(getStatus('snap-new')).toBe('waiting')
    expect(unreadIds().has('snap-new')).toBe(false)
  })

  it('a status that changed while the socket was down (reconnect) is news', () => {
    dispatchBroadcast({ t: 'status', id: 'snap-changed', status: 'working' })
    dispatchBroadcast({ t: 'status', id: 'snap-changed', status: 'waiting', snapshot: true })
    expect(unreadIds().has('snap-changed')).toBe(true)
  })
})

describe('act channel', () => {
  const frame = { t: 'act', v: 1, tool: 'canvas.type', verb: 'typed', nodeId: 'n1', n: 1 } as const // test-only
  it('hands a t:act frame to subscribers and stops after unsubscribe', () => {
    const seen: string[] = []
    const off = subscribeAct((m) => seen.push(`${m.verb}:${m.nodeId}:${m.n}`))
    expect(dispatchBroadcast(frame)).toBe(true)
    off()
    expect(dispatchBroadcast(frame)).toBe(true)
    expect(seen).toEqual(['typed:n1:1'])
  })
})

describe('net channel', () => {
  const frame = { t: 'net', v: 1, state: 'offline', since: 1000, cause: 'dns', scope: 'network' } as const // test-only
  it('hands a t:net frame to subscribers and stops after unsubscribe', () => {
    const seen: string[] = []
    const off = subscribeNet((m) => seen.push(`${m.state}:${m.since}:${m.cause}:${m.scope}`))
    expect(dispatchBroadcast(frame)).toBe(true)
    off()
    expect(dispatchBroadcast(frame)).toBe(true)
    expect(seen).toEqual(['offline:1000:dns:network'])
  })
})
