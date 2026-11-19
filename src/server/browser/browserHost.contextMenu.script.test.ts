/** @vitest-environment jsdom */
// Executes the real page-side scripts in a fresh jsdom window (an iframe) per test: the host's synthetic probe must only report
// `custom` when the SITE cancelled it, never because our own backstop did.
import { describe, expect, it } from 'vitest'
import { BACKSTOP_SCRIPT, hitExpression } from './browserHost.contextMenu.script'

function page() {
  const frame = document.body.appendChild(document.createElement('iframe'))
  const win = frame.contentWindow as unknown as Window & Record<string, unknown> & { eval(c: string): string }
  win.document.body.innerHTML = '<p id="t">hello</p>'
  const el = win.document.getElementById('t') as HTMLElement
  // jsdom has no layout: point every hit-test at the paragraph
  win.document.elementFromPoint = () => el
  win.eval(BACKSTOP_SCRIPT)
  const probe = () => JSON.parse(win.eval(hitExpression(5, 5, true))) as Record<string, unknown>
  return { win, el, probe }
}

describe('context menu probe vs backstop', () => {
  it('a page without its own handler is not custom', () => {
    const r = page().probe()
    expect(r.custom).toBeUndefined()
    expect(r).toHaveProperty('editable', false)
  })

  it('a page that cancels contextmenu itself is custom', () => {
    const p = page()
    p.win.document.addEventListener('contextmenu', (e) => e.preventDefault())
    expect(p.probe()).toEqual({ custom: true })
  })

  it('a real (non-probe) contextmenu is still cancelled by the backstop', () => {
    const p = page()
    const ev = new (p.win.MouseEvent as typeof MouseEvent)('contextmenu', { bubbles: true, cancelable: true })
    p.el.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('clears the probe flag even when a handler throws', () => {
    const p = page()
    p.win.addEventListener('error', (e) => e.preventDefault())
    p.win.document.addEventListener('contextmenu', () => { throw new Error('site bug') })
    p.probe()
    expect(p.win.__webtermProbe).toBeFalsy()
  })
})
