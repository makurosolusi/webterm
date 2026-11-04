/** @vitest-environment jsdom */
// The in-page picker: stable selectors, source lookup, payload shape, and full removal.
import { afterEach, describe, expect, it } from 'vitest'
import { DESIGN_GLOBAL, DESIGN_OVERLAY_SOURCE, installDesignOverlay, type DesignCollect } from './design.overlay'

type Api = { collect(): DesignCollect; remove(): void; hide(): void; show(): void }
const g = () => (window as unknown as Record<string, Api | undefined>)[DESIGN_GLOBAL]
const install = () => installDesignOverlay(window) as Api
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

afterEach(() => { g()?.remove(); document.body.innerHTML = '' })

describe('design overlay', () => {
  it('builds stable unique selectors: id, test attribute, else nth-of-type path to an anchor', () => {
    document.body.innerHTML = `
      <button id="save">Save</button>
      <button id=":r1:" data-testid="cancel">Cancel</button>
      <section id="list"><ul><li>a</li><li>b</li></ul></section>`
    const api = install()
    const li = document.querySelectorAll('li')[1]
    for (const el of [document.getElementById('save')!, document.querySelector('[data-testid=cancel]')!, li]) click(el)
    const sels = api.collect().picks.map((p) => p.selector)
    expect(sels).toEqual(['#save', 'button[data-testid="cancel"]', '#list > ul > li:nth-of-type(2)'])
    // Stable: re-collecting gives the same selectors, and each resolves to exactly its element.
    expect(api.collect().picks.map((p) => p.selector)).toEqual(sels)
    expect(document.querySelectorAll(sels[2])).toHaveLength(1)
    expect(document.querySelector(sels[2])).toBe(li)
  })

  it('collect() reports url, viewport, html, styles, box and source (data attribute or React fiber)', () => {
    document.body.innerHTML = '<div data-inspector-relative-path="src/App.tsx" data-inspector-line="12" data-inspector-column="4"><b>x</b></div><p>y</p>'
    const p = document.querySelector('p')!
    Object.assign(p, { __reactFiber$abc: { type: 'p', return: { type: { name: 'Card' }, _debugSource: { fileName: 'src/Card.tsx', lineNumber: 7, columnNumber: 3 } } } })
    const api = install()
    click(document.querySelector('b')!); click(p)
    const c = api.collect()
    expect(c.url).toBe(window.location.href)
    expect(c.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight, scrollX: 0, scrollY: 0 })
    expect(c.picks[0]).toMatchObject({ tag: 'b', html: '<b>x</b>', source: 'src/App.tsx:12:4' })
    expect(c.picks[0].box).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(typeof c.picks[0].styles.display).toBe('string')
    expect(c.picks[1]).toMatchObject({ tag: 'p', source: 'src/Card.tsx:7:3', component: 'Card' })
  })

  it('click toggles a pick, swallows the page click, Esc clears', () => {
    document.body.innerHTML = '<a href="#x">go</a>'
    let pageSaw = 0
    const a = document.querySelector('a')!
    a.addEventListener('click', () => pageSaw++)
    const api = install()
    click(a)
    expect(pageSaw).toBe(0)
    expect(api.collect().picks).toHaveLength(1)
    click(a)
    expect(api.collect().picks).toHaveLength(0)
    click(a)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(api.collect().picks).toHaveLength(0)
  })

  it('remove() takes every node, listener and the global away', () => {
    document.body.innerHTML = '<a href="#x">go</a>'
    const api = install()
    expect(document.querySelectorAll('[data-webterm-design]').length).toBeGreaterThan(0)
    api.remove()
    expect(document.querySelectorAll('[data-webterm-design]')).toHaveLength(0)
    expect(g()).toBeUndefined()
    let pageSaw = 0
    document.querySelector('a')!.addEventListener('click', () => pageSaw++)
    click(document.querySelector('a')!)
    expect(pageSaw).toBe(1)
  })

  it('the serialized source runs standalone and is idempotent', () => {
    document.body.innerHTML = '<i id="k">k</i>'
    new Function(DESIGN_OVERLAY_SOURCE)()
    const first = g()
    new Function(DESIGN_OVERLAY_SOURCE)()
    expect(g()).toBe(first)
    click(document.getElementById('k')!)
    expect(g()!.collect().picks.map((p) => p.selector)).toEqual(['#k'])
    expect(document.querySelectorAll('[data-webterm-design]').length).toBe(4) // root, hover frame, badge, one pick frame
  })
})
