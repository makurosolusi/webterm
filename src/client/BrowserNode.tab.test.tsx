/** @vitest-environment jsdom */
// Browser node in tab mode: a hidden tab detaches the stream; canvas zoom no longer pauses it.
import type { ComponentProps } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const fake = vi.hoisted(() => ({
  calls: [] as string[],
  stream: null as unknown,
}))
vi.mock('./browser.stream', () => ({
  browserStream: {
    subscribe: () => () => undefined,
    attach: () => { fake.calls.push('attach') },
    resize: () => undefined,
    setAudio: () => undefined, detach: () => { fake.calls.push('detach') },
    send: () => undefined,
  },
}))
// Canvas zoom is 0.1 (< ZOOM_PAUSE_BELOW) for every node in this file.
vi.mock('@xyflow/react', async (orig) => {
  const actual = await orig<typeof import('@xyflow/react')>()
  return { ...actual, useStore: (sel: (s: unknown) => unknown) => sel({ transform: [0, 0, 0.1] }) }
})

import BrowserNode from './BrowserNode'
import { NodeHostContext } from './tabLayout.context'

type RoCb = (e: Array<{ contentRect: { width: number; height: number } }>) => void
let roCbs: RoCb[] = []
class FakeRO {
  constructor(cb: RoCb) { roCbs.push(cb) }
  observe() {}
  disconnect() {}
}

const mount = (host: { inTab: boolean; visible: boolean; maximized?: boolean } | null, collapsed = false) =>
  render(
    <ReactFlowProvider>
      <NodeHostContext.Provider value={{ maximized: false, ...(host ?? { inTab: false, visible: true }) }}>
        <BrowserNode {...({ id: 'b1', data: { title: 't', collapsed }, selected: false } as unknown as ComponentProps<typeof BrowserNode>)} />
      </NodeHostContext.Provider>
    </ReactFlowProvider>,
  )
const size = () => act(() => { for (const cb of roCbs) cb([{ contentRect: { width: 800, height: 600 } }]) })

beforeEach(() => {
  fake.calls.length = 0; roCbs = []
  vi.stubGlobal('ResizeObserver', FakeRO)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('BrowserNode in tab mode', () => {
  it('canvas: low canvas zoom keeps the stream paused (unchanged behaviour)', () => {
    mount(null)
    size()
    expect(fake.calls).not.toContain('attach')
  })

  it('tab: canvas zoom is ignored, the visible tab attaches', () => {
    mount({ inTab: true, visible: true })
    size()
    expect(fake.calls).toContain('attach')
  })

  it('tab: a persisted canvas "collapsed" does not pause the visible tab', () => {
    mount({ inTab: true, visible: true }, true)
    size()
    expect(fake.calls).toContain('attach')
  })

  it('tab: a hidden tab never attaches, and detaches when it becomes hidden', () => {
    const r = mount({ inTab: true, visible: true })
    size()
    expect(fake.calls).toEqual(['attach'])
    r.rerender(
      <ReactFlowProvider>
        <NodeHostContext.Provider value={{ inTab: true, visible: false, maximized: false }}>
          <BrowserNode {...({ id: 'b1', data: { title: 't' }, selected: false } as unknown as ComponentProps<typeof BrowserNode>)} />
        </NodeHostContext.Provider>
      </ReactFlowProvider>,
    )
    expect(fake.calls).toEqual(['attach', 'detach'])
  })

  it('tab: hidden from the start never attaches', () => {
    mount({ inTab: true, visible: false })
    size()
    expect(fake.calls).not.toContain('attach')
  })
})
