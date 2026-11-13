/** @vitest-environment jsdom */
// A narrow node header (min node width 240px) must keep "…", Stop and Close and move the
// lower-priority actions into the "…" menu, like a VS Code toolbar; a wide one shows them inline.
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import NodeChrome from './NodeChrome'
import { fitCount } from './nodeToolbar.overflow'

vi.mock('@xyflow/react', async (orig) => ({ ...(await orig<typeof import('@xyflow/react')>()), useNodeId: () => 'n1' }))

// jsdom has no layout: each action is ITEM px wide with GAP px between, the group is `groupWidth` wide.
const ITEM = 22 // test-only
const GAP = 2 // test-only
let groupWidth = 0
const observers: ResizeObserverCallback[] = []
const g = globalThis as unknown as { ResizeObserver?: unknown }
const saved = g.ResizeObserver
const proto = HTMLElement.prototype
const props = ['clientWidth', 'offsetWidth', 'offsetLeft'] as const
const original = props.map((p) => Object.getOwnPropertyDescriptor(proto, p))
const isItem = (el: HTMLElement) => el.classList.contains('node-toolbar__item')

beforeAll(() => {
  g.ResizeObserver = class { constructor(cb: ResizeObserverCallback) { observers.push(cb) } observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get(this: HTMLElement) { return this.classList.contains('node-toolbar__overflow') ? groupWidth : 0 } })
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return isItem(this) ? ITEM : 0 } })
  Object.defineProperty(proto, 'offsetLeft', { configurable: true, get(this: HTMLElement) { return isItem(this) ? [...this.parentElement!.children].indexOf(this) * (ITEM + GAP) : 0 } })
})
afterAll(() => {
  g.ResizeObserver = saved
  props.forEach((p, i) => { if (original[i]) Object.defineProperty(proto, p, original[i]!) })
})
afterEach(() => { cleanup(); observers.length = 0 })

const base = {
  title: 'a long agent title', onRename: () => {}, collapsed: false, onToggleCollapse: () => {}, color: '#fff', onColor: () => {},
  comments: [], onAddComment: () => {}, onRefresh: () => {}, searchOpen: false, onToggleSearch: () => {}, onClose: () => {}, onStop: () => {},
}
function mount(width: number) {
  const r = render(<NodeChrome {...base} />)
  groupWidth = width
  act(() => observers.forEach((cb) => cb([], {} as ResizeObserver)))
  const shown = [...r.container.querySelectorAll('[data-title]')]
    .filter((b) => !b.closest('[data-overflow]'))
    .map((b) => b.getAttribute('data-title'))
  fireEvent.click(r.container.querySelector('[data-title="More Actions…"]') as Element)
  const rows = [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((x) => x.textContent ?? '')
  return { shown, rows }
}

describe('fitCount', () => {
  it('counts the leading items whose right edge fits', () => {
    expect(fitCount(100, [22, 46, 70])).toBe(3)
    expect(fitCount(46, [22, 46, 70])).toBe(2)
    expect(fitCount(21, [22, 46, 70])).toBe(0)
    expect(fitCount(0, [])).toBe(0)
  })
})

describe('node header overflow', () => {
  it('narrow (240px node): Close, Stop and More stay; Search and Maximize move into the menu', () => {
    const { shown, rows } = mount(0)
    expect(shown).toEqual(expect.arrayContaining(['More Actions…', 'Stop Agent (keeps the node)', 'Close (ends the session)']))
    expect(shown).not.toContain('Search')
    expect(shown).not.toContain('Maximize')
    expect(rows.slice(0, 2)).toEqual(['Search', 'Maximize'])
    expect(rows).not.toContain('Resize this node') // edges resize; there is no resize mode button or row
  })

  it('drops the lowest-priority actions first', () => {
    const { shown, rows } = mount(ITEM)
    expect(shown).toContain('Search')
    expect(shown).not.toContain('Maximize')
    expect(rows[0]).toBe('Maximize')
    expect(rows).not.toContain('Search')
  })

  it('wide: every action is inline and the menu has no overflow rows', () => {
    const { shown, rows } = mount(400)
    expect(shown).toEqual(expect.arrayContaining(['Search', 'Maximize', 'More Actions…', 'Stop Agent (keeps the node)', 'Close (ends the session)']))
    expect(rows).not.toContain('Search')
    expect(rows).not.toContain('Maximize')
    expect(rows).not.toContain('Resize this node')
  })
})
