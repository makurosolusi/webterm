/** @vitest-environment jsdom */
import { afterEach, describe, expect, test } from 'vitest'
import { countShotElements, shotFilter } from './canvasShot.scope'

const VIEW = { width: 1000, height: 800 }
const keep = shotFilter(VIEW)

// jsdom has no layout: every rect is zeros, so each test places its elements by hand.
function at(el: Element, left: number, top: number, width = 100, height = 100): Element {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) })
  return el
}
function el(cls = '', parent: Element = document.body): HTMLElement {
  const e = document.createElement('div')
  if (cls) e.className = cls
  parent.appendChild(e)
  return e
}
function scrolling(e: HTMLElement): HTMLElement {
  Object.defineProperty(e, 'scrollHeight', { configurable: true, value: 5000 })
  Object.defineProperty(e, 'clientHeight', { configurable: true, value: 500 })
  return e
}

afterEach(() => { document.body.replaceChildren() })

describe('shotFilter', () => {
  test('keeps text nodes', () => {
    expect(keep(document.createTextNode('hi'))).toBe(true)
  })

  test('skips an element the browser reports as not visible (display:none)', () => {
    const e = at(el(), 0, 0)
    ;(e as unknown as { checkVisibility: () => boolean }).checkVisibility = () => false
    expect(keep(e)).toBe(false)
  })

  test('keeps an on-screen element and one with no box', () => {
    expect(keep(at(el('react-flow__node'), 10, 10))).toBe(true)
    expect(keep(el('react-flow__node'))).toBe(true)
  })

  test('skips an off-screen react-flow node', () => {
    expect(keep(at(el('react-flow__node'), 1200, 0))).toBe(false)
    expect(keep(at(el('react-flow__node'), 0, -500))).toBe(false)
  })

  test('skips an off-screen child of a scrolling parent (scrolled-out chat rows)', () => {
    const list = scrolling(el())
    expect(keep(at(el('', list), 0, 2000))).toBe(false)
    expect(keep(at(el('', list), 0, 100))).toBe(true)
  })

  test('keeps an off-screen container that is not self-contained (.react-flow__viewport)', () => {
    expect(keep(at(el('react-flow__viewport'), -3000, -3000))).toBe(true)
  })
})

describe('countShotElements', () => {
  test('counts kept elements and does not descend into skipped ones', () => {
    const a = el()
    el('', a); el('', a)
    const hidden = at(el('react-flow__node'), 5000, 0)
    el('', hidden); el('', hidden)
    expect(countShotElements(document.body, keep, 100)).toBe(3)
  })

  test('stops at limit + 1', () => {
    for (let i = 0; i < 50; i++) el()
    let calls = 0
    const counting = (n: Node) => { calls++; return keep(n) }
    expect(countShotElements(document.body, counting, 10)).toBe(11)
    expect(calls).toBe(11)
  })
})
