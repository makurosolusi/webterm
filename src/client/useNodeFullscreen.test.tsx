/** @vitest-environment jsdom */
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NodeChrome from './NodeChrome'
import { useNodeFullscreen } from './useNodeFullscreen'

let current: Element | null = null
let enabled = true
const request = vi.fn()
const exit = vi.fn()

const def = (o: object, k: string, v: unknown) => Object.defineProperty(o, k, { value: v, configurable: true, writable: true })
const fire = (el: Element | null) => { current = el; act(() => { document.dispatchEvent(new Event('fullscreenchange')) }) }

beforeEach(() => {
  current = null; enabled = true
  request.mockReset().mockImplementation(function (this: Element) { return Promise.resolve().then(() => fire(this)) })
  exit.mockReset().mockImplementation(() => Promise.resolve().then(() => fire(null)))
  def(Element.prototype, 'requestFullscreen', request)
  def(document, 'exitFullscreen', exit)
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => enabled })
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => current })
})
afterEach(cleanup)

/** Hook dipasang pada header di dalam wrapper `.react-flow__node`, persis seperti NodeChrome. */
function setup() {
  const wrap = document.createElement('div'); wrap.className = 'react-flow__node'
  const header = document.createElement('div'); wrap.appendChild(header); document.body.appendChild(wrap)
  const hook = renderHook(() => { const r = useRef<HTMLElement | null>(header); return useNodeFullscreen(r) })
  return { wrap, hook }
}

describe('useNodeFullscreen', () => {
  it('requests fullscreen on the React Flow node wrapper and follows fullscreenchange', async () => {
    const { wrap, hook } = setup()
    expect(hook.result.current.isFullscreen).toBe(false)
    await act(async () => { hook.result.current.toggle() })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.contexts[0]).toBe(wrap)
    expect(hook.result.current.isFullscreen).toBe(true)
    await act(async () => { hook.result.current.toggle() })
    expect(exit).toHaveBeenCalledTimes(1)
    expect(hook.result.current.isFullscreen).toBe(false)
  })

  it('drops the state when the browser exits on its own (Esc) and ignores other fullscreen elements', () => {
    const { wrap, hook } = setup()
    fire(wrap)
    expect(hook.result.current.isFullscreen).toBe(true)
    fire(null)
    expect(hook.result.current.isFullscreen).toBe(false)
    fire(document.body)
    expect(hook.result.current.isFullscreen).toBe(false)
  })

  it('warns (op + error name, no throw) on a rejected or throwing requestFullscreen', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { hook } = setup()
    const denied = new Error('denied'); denied.name = 'TypeError'
    request.mockImplementationOnce(() => Promise.reject(denied))
    await act(async () => { hook.result.current.toggle() })
    expect(warn).toHaveBeenCalledWith('[useNodeFullscreen] requestFullscreen gagal: TypeError')
    request.mockImplementationOnce(() => { throw new Error('sync') })
    await act(async () => { hook.result.current.toggle() })
    expect(warn).toHaveBeenCalledWith('[useNodeFullscreen] requestFullscreen gagal: Error')
    expect(hook.result.current.isFullscreen).toBe(false)
    warn.mockRestore()
  })

  it('is disabled and never calls the API when Fullscreen is unavailable', () => {
    enabled = false
    const { hook } = setup()
    expect(hook.result.current.fullscreenDisabled).toBe(true)
    act(() => hook.result.current.toggle())
    expect(request).not.toHaveBeenCalled()
  })
})

describe('NodeChrome full screen wiring', () => {
  const props = {
    title: 'api', onRename: () => {}, collapsed: false, onToggleCollapse: () => {},
    color: '#fff', onColor: () => {}, comments: [], onAddComment: () => {},
    onRefresh: () => {}, searchOpen: false, onToggleSearch: () => {},
    maximized: false, onToggleMaximize: vi.fn(), onClose: () => {},
  }

  it('clicking Full Screen fullscreens the enclosing node; Maximize stays independent', async () => {
    const { container } = render(<div className="react-flow__node"><NodeChrome {...props} /></div>)
    const labels = () => [...container.querySelectorAll('vscode-toolbar-button')].map((b) => b.getAttribute('data-title'))
    const l = labels()
    expect(l.slice(l.indexOf('Search'), l.indexOf('Search') + 3)).toEqual(['Search', 'Maximize', 'Full Screen'])
    expect(l[l.indexOf('Full Screen') + 1]).toBe('More Actions…')
    await act(async () => { (container.querySelector('[data-title="Full Screen"]') as HTMLElement).click() })
    expect(request.mock.contexts[0]).toBe(container.firstChild)
    expect(labels()).toContain('Exit Full Screen')
    expect(container.querySelector('[data-title="Exit Full Screen"]')?.getAttribute('aria-disabled')).toBeNull()
    expect(props.onToggleMaximize).not.toHaveBeenCalled()
  })
})

describe('fullscreen CSS', () => {
  it('has a solid background and drops node border/glow inside :fullscreen', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/client/node-chrome.css'), 'utf8')
    expect(css).toMatch(/\.react-flow__node:fullscreen\s*{\s*background:\s*var\(--panel\)/)
    expect(css).toMatch(/\.react-flow__node:fullscreen \.term-node\s*{\s*border:\s*0;\s*border-radius:\s*0/)
    expect(css).toMatch(/:fullscreen::after\s*{\s*display:\s*none/)
  })
})
