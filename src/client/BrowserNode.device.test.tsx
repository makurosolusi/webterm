/** @vitest-environment jsdom */
// BrowserNode in device mode: header + rotate sends the device message, and pointer input maps onto the device frame.
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { ClientMsg } from '../shared/browser.contract'
import { DEVICE_TEXT } from './browser.device'

const fake = vi.hoisted(() => {
  const sent: unknown[] = []
  return {
    sent,
    stream: {
      subscribe: () => () => undefined,
      attach: (_id: string, vp: object) => { sent.push({ t: 'attach', ...vp }) },
      resize: (_id: string, vp: object) => { sent.push({ t: 'resize', ...vp }) },
      detach: () => undefined,
      send: (m: ClientMsg) => { sent.push(m) },
    },
  }
})
vi.mock('./browser.stream', () => ({ browserStream: fake.stream }))

import BrowserNode from './BrowserNode'

type RoCb = (e: Array<{ contentRect: { width: number; height: number } }>) => void
let roCbs: RoCb[] = []
const sentOf = (t: string) => fake.sent.filter((m) => (m as { t: string }).t === t) as Array<Record<string, unknown>>

beforeEach(() => {
  fake.sent.length = 0; roCbs = []
  vi.stubGlobal('ResizeObserver', class { constructor(cb: RoCb) { roCbs.push(cb) } observe() {} disconnect() {} })
  // Letterboxed frame: 393x852 device shown at 196.5x426 (half size).
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(
    { left: 100, top: 20, width: 196.5, height: 426, right: 296.5, bottom: 446, x: 100, y: 20, toJSON: () => ({}) })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const mount = () => render(
  <ReactFlowProvider>
    <BrowserNode {...({ id: 'b1', data: { title: 't', device: { id: 'iphone-15-pro' } }, selected: false } as unknown as ComponentProps<typeof BrowserNode>)} />
  </ReactFlowProvider>,
)

describe('BrowserNode device mode', () => {
  it('shows the device header and letterbox class, and rotate sends the device message', () => {
    const r = mount()
    expect(screen.getByText('iPhone 15 Pro · 393×852 · 3x')).toBeTruthy()
    expect(r.container.querySelector('.browser-zoom--device')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: DEVICE_TEXT.rotate }))
    expect(sentOf('device')).toEqual([{ t: 'device', id: 'b1', device: { id: 'iphone-15-pro', landscape: true } }])
  })

  it('maps pointer input to device CSS px, not the node size', () => {
    const r = mount()
    act(() => { for (const cb of roCbs) cb([{ contentRect: { width: 900, height: 500 } }]) }) // attach with node size
    expect(sentOf('attach')[0]).toMatchObject({ w: 900, h: 500 })
    const surface = r.container.querySelector('.browser-surface') as HTMLElement
    fireEvent.pointerDown(surface, { clientX: 100 + 98.25, clientY: 20 + 213, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse' })
    const down = sentOf('mouse')[0]
    expect(down.x).toBeCloseTo(196.5)
    expect(down.y).toBeCloseTo(426)
  })
})
