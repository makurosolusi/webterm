import { afterEach, describe, expect, it } from 'vitest'
import type { Workspace, WsNode } from '../../shared/workspace'
import { TOKEN_HEADER } from '../auth'
import { forgetNodeToken, NODE_TOKEN_HEADER, nodeToken } from '../hooksTokens'
import { requesterOf, resolveLinkedBrowser } from './browser.linkedTarget'

const node = (id: string, kind: WsNode['kind'], title?: string): WsNode => ({ id, kind, x: 0, y: 0, ...(title ? { title } : {}) })
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target, kind: 'context' as const })
const ws = (nodes: WsNode[], bridges: Workspace['bridges'] = []): Workspace =>
  ({ id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, nodes, bridges, updatedAt: 0 })

describe('resolveLinkedBrowser', () => {
  it('one cable (either direction) = that browser, by default', () => {
    expect(resolveLinkedBrowser([ws([node('a1', 'agent'), node('b1', 'browser')], [edge('a1', 'b1')])], 'a1')).toMatchObject({ ok: true, nodeId: 'b1' })
    expect(resolveLinkedBrowser([ws([node('a1', 'agent'), node('b1', 'browser')], [edge('b1', 'a1')])], 'a1')).toMatchObject({ ok: true, nodeId: 'b1' })
  })

  it('an unwired browser is never picked, even when it is the only one on the board', () => {
    const r = resolveLinkedBrowser([ws([node('a1', 'agent'), node('b1', 'browser', 'Docs')])], 'a1')
    expect(r).toMatchObject({ ok: false, result: { status: 404, body: { error: 'no_linked_browser', available: [{ id: 'b1', title: 'Docs' }] } } })
    if (!r.ok) expect((r.result.body as { message: string }).message).toMatch(/cable/)
  })

  it('several cables = must pick; picking a wired one works, an unwired one is refused', () => {
    const w = ws([node('a1', 'agent'), node('b1', 'browser'), node('b2', 'browser'), node('b3', 'browser')], [edge('a1', 'b1'), edge('b2', 'a1')])
    expect(resolveLinkedBrowser([w], 'a1')).toMatchObject({ ok: false, result: { status: 409, body: { error: 'ambiguous_browser', linked: [{ id: 'b1' }, { id: 'b2' }] } } })
    expect(resolveLinkedBrowser([w], 'a1', 'b2')).toMatchObject({ ok: true, nodeId: 'b2' })
    expect(resolveLinkedBrowser([w], 'a1', 'b3')).toMatchObject({ ok: false, result: { status: 403, body: { error: 'not_linked' } } })
  })

  it('--node may be a wired browser\'s name (any case): the real node id comes back; an unwired name is still refused', () => {
    const w = ws([node('a1', 'agent'), { ...node('b1', 'browser'), name: 'Fox' }, { ...node('b2', 'browser'), name: 'Owl' }, { ...node('b3', 'browser'), name: 'Elk' }],
      [edge('a1', 'b1'), edge('a1', 'b2')])
    expect(resolveLinkedBrowser([w], 'a1', 'fox')).toMatchObject({ ok: true, nodeId: 'b1' })
    expect(resolveLinkedBrowser([w], 'a1', 'Owl')).toMatchObject({ ok: true, nodeId: 'b2' })
    expect(resolveLinkedBrowser([w], 'a1', 'Elk')).toMatchObject({ ok: false, result: { status: 403, body: { error: 'not_linked' } } })
    expect(resolveLinkedBrowser([w], 'a1')).toMatchObject({ ok: false, result: { body: { linked: [{ id: 'b1', name: 'Fox' }, { id: 'b2', name: 'Owl' }] } } })
  })

  it('a cable to a non-browser node does not count; another agent wired to the browser grants nothing to this one', () => {
    const w = ws([node('a1', 'agent'), node('a2', 'agent'), node('b1', 'browser')], [edge('a1', 'a2'), edge('a2', 'b1')])
    expect(resolveLinkedBrowser([w], 'a1')).toMatchObject({ ok: false, result: { body: { error: 'no_linked_browser' } } })
    expect(resolveLinkedBrowser([w], 'a1', 'b1')).toMatchObject({ ok: false, result: { status: 403 } })
    expect(resolveLinkedBrowser([w], 'a2')).toMatchObject({ ok: true, nodeId: 'b1' })
  })

  it('unknown requester = not on a board', () => {
    expect(resolveLinkedBrowser([ws([node('b1', 'browser')])], 'ghost')).toMatchObject({ ok: false, result: { status: 404, body: { error: 'not_on_board' } } })
  })
})

describe('requesterOf', () => {
  afterEach(() => forgetNodeToken('a1'))
  it('maps a node token (transport or nodeterm header) to its node; anything else is anonymous', () => {
    const t = nodeToken('a1')
    expect(requesterOf({ [TOKEN_HEADER]: t })).toBe('a1')
    expect(requesterOf({ [NODE_TOKEN_HEADER]: t })).toBe('a1')
    expect(requesterOf({ [TOKEN_HEADER]: 'root-or-foreign' })).toBeUndefined()
    expect(requesterOf({})).toBeUndefined()
    expect(requesterOf(undefined)).toBeUndefined()
  })
})
