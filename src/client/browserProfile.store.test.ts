// profileId survives the board round trip; nodes saved before profiles (no profileId) stay valid.
import { describe, expect, it, vi } from 'vitest'
import { toFlow, toWsNode } from './store'
import { dispatchBroadcast, subscribeBrowserProfiles } from './ws.listeners'
import type { WsNode } from '../shared/workspace'

const node = (extra: Partial<WsNode>): WsNode => ({ id: 'n1', kind: 'browser', x: 0, y: 0, ...extra })

describe('browser node profileId', () => {
  it('round-trips through toFlow and toWsNode', () => {
    expect(toWsNode(toFlow(node({ profileId: 'bp-abc123' }))).profileId).toBe('bp-abc123')
  })
  it('a node without profileId stays without (means Default)', () => {
    const out = toWsNode(toFlow(node({})))
    expect(out.profileId).toBeUndefined()
    expect(out.kind).toBe('browser')
  })
  it('drops an id that cannot be a profile id', () => {
    expect(toWsNode(toFlow(node({ profileId: '../evil' }))).profileId).toBeUndefined()
  })
})

describe('browserProfiles frame', () => {
  it('reaches subscribers until they unsubscribe', () => {
    const cb = vi.fn()
    const off = subscribeBrowserProfiles(cb)
    expect(dispatchBroadcast({ t: 'browserProfiles' })).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    dispatchBroadcast({ t: 'browserProfiles' })
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
