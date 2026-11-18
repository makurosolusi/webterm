import { describe, expect, it } from 'vitest'
import type { BrowserInputEvent } from '../../shared/browser.contract'
import { CdpCommandError } from './cdp.client'
import { clickTarget, describeAt, findTarget, typeTarget } from './browser.semantic'
import type { TabIo } from './browser.semantic'
import type { AxNode } from './browserAgent.snapshot'

const ax = (nodeId: string, role: string, name: string, backend: number, childIds: string[] = [], extra: Partial<AxNode> = {}): AxNode =>
  ({ nodeId, role: { value: role }, name: { value: name }, backendDOMNodeId: backend, childIds, ...extra })

// root > [heading "Pricing", button "Buy"(10) > StaticText "Buy"(11), link "Docs"(12), button "Buy"(13), textbox "Email"(14)]
const tree: AxNode[] = [
  ax('1', 'RootWebArea', 'Shop', 1, ['2', '3', '5', '6', '7']),
  ax('2', 'heading', 'Pricing', 2),
  ax('3', 'button', 'Buy', 10, ['4']),
  ax('4', 'StaticText', 'Buy', 11),
  ax('5', 'link', 'Docs', 12),
  ax('6', 'button', 'Buy', 13),
  ax('7', 'textbox', 'Email', 14),
  ax('8', 'button', 'Hidden', 15, [], { ignored: true }),
]

describe('findTarget', () => {
  it('finds by role, name and n-th among equals', () => {
    expect(findTarget(tree, { role: 'button', name: 'Buy', nth: 1 })?.backendDOMNodeId).toBe(10)
    expect(findTarget(tree, { role: 'button', name: 'buy', nth: 2 })?.backendDOMNodeId).toBe(13)
    expect(findTarget(tree, { role: 'button', name: 'Buy', nth: 3 })).toBeUndefined()
  })
  it('prefers the control over the static text inside it when no role is given', () => {
    expect(findTarget(tree, { name: 'Buy', nth: 1 })?.backendDOMNodeId).toBe(10)
  })
  it('exact match only, unless asked to fall back to "contains"', () => {
    expect(findTarget(tree, { name: 'Doc', nth: 1 })).toBeUndefined()
    expect(findTarget(tree, { name: 'Doc', nth: 1 }, false)?.backendDOMNodeId).toBe(12)
  })
  it('never matches ignored or unnamed nodes', () => { expect(findTarget(tree, { name: 'Hidden', nth: 1 })).toBeUndefined() })
})

describe('describeAt', () => {
  it('climbs from the clicked text to its control and counts its place', () => {
    expect(describeAt(tree, 11)).toEqual({ role: 'button', name: 'buy', nth: 1 })
    expect(describeAt(tree, 13)).toEqual({ role: 'button', name: 'buy', nth: 2 })
    expect(describeAt(tree, 2)).toEqual({ role: 'heading', name: 'pricing', nth: 1 })
  })
  it('returns null when nothing named is under the pointer', () => { expect(describeAt(tree, 999)).toBeNull() })
  it('round trips: what describeAt names, findTarget finds in another page with the same shape', () => {
    for (const id of [10, 12, 13, 14]) expect(findTarget(tree, describeAt(tree, id)!)?.backendDOMNodeId).toBe(id)
  })
})

function io(nodes: AxNode[], over: Partial<Record<string, (p: never) => unknown>> = {}): TabIo & { sent: BrowserInputEvent[]; calls: string[] } {
  const sent: BrowserInputEvent[] = []
  const calls: string[] = []
  return {
    sent, calls,
    async cdp(method, params) {
      calls.push(method)
      if (over[method]) return over[method]!(params as never)
      if (method === 'Accessibility.getFullAXTree') return { nodes }
      if (method === 'DOM.getContentQuads') return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] }
      if (method === 'DOM.describeNode') return { node: { attributes: [] } }
      return {}
    },
    async input(ev) { sent.push(ev) },
  }
}

describe('clickTarget / typeTarget', () => {
  it('clicks the middle of the matched element', async () => {
    const t = io(tree)
    expect(await clickTarget(t, { role: 'link', name: 'docs', nth: 1 }, 'https://a.test/')).toBe('ok')
    expect(t.sent.map((e) => (e as { type?: string }).type)).toEqual(['move', 'down', 'up'])
    expect(t.sent[1]).toMatchObject({ x: 5, y: 5 })
  })
  it('answers no_match when the page has no such element, and sends nothing', async () => {
    const t = io(tree)
    expect(await clickTarget(t, { role: 'button', name: 'Missing', nth: 1 }, 'https://a.test/')).toBe('no_match')
    expect(t.sent).toEqual([])
  })
  it('treats an element that vanished mid-action as no_match, but rethrows other failures', async () => {
    const vanished = io(tree, { 'DOM.scrollIntoViewIfNeeded': () => { throw new CdpCommandError('x', 'DOM.scrollIntoViewIfNeeded', -32000, 'Node not found') } })
    expect(await clickTarget(vanished, { name: 'Docs', nth: 1 }, 'https://a.test/')).toBe('no_match')
    const broken = io(tree, { 'DOM.getContentQuads': () => { throw new Error('socket closed') } })
    await expect(clickTarget(broken, { name: 'Docs', nth: 1 }, 'https://a.test/')).rejects.toThrow('socket closed')
  })
  it('refuses a click on a control that submits to another origin', async () => {
    const t = io(tree, { 'DOM.describeNode': () => ({ node: { attributes: ['formaction', 'https://evil.test/post'] } }) })
    expect(await clickTarget(t, { name: 'Docs', nth: 1 }, 'https://a.test/')).toBe('cross_origin')
    expect(t.sent).toEqual([])
    const same = io(tree, { 'DOM.describeNode': () => ({ node: { attributes: ['formaction', '/post'] } }) })
    expect(await clickTarget(same, { name: 'Docs', nth: 1 }, 'https://a.test/')).toBe('ok')
  })
  it('types into the focused field, then Enter when asked', async () => {
    const t = io(tree)
    expect(await typeTarget(t, { role: 'textbox', name: 'Email', nth: 1 }, 'a@b.test', true)).toBe('ok')
    expect(t.calls).toContain('DOM.focus')
    expect(t.sent[0]).toEqual({ t: 'text', text: 'a@b.test' })
    expect(t.sent.slice(1).map((e) => (e as { key?: string }).key)).toEqual(['Enter', 'Enter'])
    expect(await typeTarget(io(tree), { name: 'Nope', nth: 1 }, 'x', false)).toBe('no_match')
  })
})
