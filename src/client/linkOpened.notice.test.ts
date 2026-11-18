import { describe, expect, it } from 'vitest'
import type { LinkOpenedMsg } from '../shared/protocol'
import { dispatchBroadcast, subscribeLinkOpened } from './ws.listeners'
import { linkOpenedTitle } from './linkOpened.notice'

describe('captured terminal link notice', () => {
  it('names the host only, and says when a browser node was added', () => {
    expect(linkOpenedTitle({ host: 'github.com' })).toBe('Link opened in canvas browser: github.com')
    expect(linkOpenedTitle({ host: 'github.com', created: true })).toBe('Link opened in canvas browser: github.com (new browser node added next to the terminal)')
  })

  it('the shared socket delivers a linkOpened frame to its subscribers and to no terminal', () => {
    const got: LinkOpenedMsg[] = []
    const off = subscribeLinkOpened((m) => got.push(m))
    const frame: LinkOpenedMsg = { t: 'linkOpened', workspaceId: 'w1', nodeId: 'b1', host: 'example.com', created: true }
    expect(dispatchBroadcast(frame)).toBe(true)
    off()
    expect(dispatchBroadcast(frame)).toBe(true)
    expect(got).toEqual([frame])
  })
})
