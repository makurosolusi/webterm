/** @vitest-environment jsdom */
// Device mode on the client: toolbar picker, header + rotate, and pointer mapping onto a letterboxed device frame.
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { resolveDevice } from '../shared/browser.devices'
import { toPagePoint } from '../shared/browser.coords'
import BrowserDeviceHeader from './BrowserDeviceHeader'
import BrowserDevicePicker from './BrowserDevicePicker'
import { DEVICE_TEXT, deviceStyle, useDeviceSession } from './browser.device'
import { mouseMsg } from './browser.input'
import type { BrowserSession } from './browser.useSession'

afterEach(cleanup)
const openPicker = () => fireEvent.click(screen.getByRole('button', { name: DEVICE_TEXT.button }))

describe('BrowserDevicePicker', () => {
  it('opens the picker and selects a preset, keeping the orientation', () => {
    const onChange = vi.fn()
    render(<BrowserDevicePicker value={{ id: 'pixel-8', landscape: true }} onChange={onChange} />)
    expect(screen.getByRole('button', { name: DEVICE_TEXT.button }).getAttribute('aria-pressed')).toBe('true')
    openPicker()
    fireEvent.click(screen.getByRole('button', { name: /iPhone 15 Pro393×852/ }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ id: 'iphone-15-pro', landscape: true })
    expect(screen.queryByRole('button', { name: DEVICE_TEXT.responsive })).toBeNull() // closed after a choice
  })

  it('Responsive sends null and is marked current when no device is set', () => {
    const onChange = vi.fn()
    render(<BrowserDevicePicker onChange={onChange} />)
    expect(screen.getByRole('button', { name: DEVICE_TEXT.button }).getAttribute('aria-pressed')).toBe('false')
    openPicker()
    const responsive = screen.getByRole('button', { name: DEVICE_TEXT.responsive })
    expect(responsive.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(responsive)
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('applies a valid custom size and rejects one out of bounds', () => {
    const onChange = vi.fn()
    render(<BrowserDevicePicker onChange={onChange} />)
    openPicker()
    const set = (label: string, v: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: v } })
    set(DEVICE_TEXT.width, '10')
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
    expect(screen.getByRole('alert').textContent).toMatch(/from 50 to 4096/)
    expect(onChange).not.toHaveBeenCalled()
    set(DEVICE_TEXT.width, '360'); set(DEVICE_TEXT.height, '640'); set(DEVICE_TEXT.dpr, '1.5')
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ id: 'custom', w: 360, h: 640, dpr: 1.5 })
  })
})

describe('BrowserDeviceHeader', () => {
  it('shows name, size and DPR, and rotates', () => {
    const onRotate = vi.fn()
    render(<BrowserDeviceHeader device={resolveDevice({ id: 'iphone-15-pro' })} onRotate={onRotate} />)
    expect(screen.getByText('iPhone 15 Pro · 393×852 · 3x')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: DEVICE_TEXT.rotate }))
    expect(onRotate).toHaveBeenCalledOnce()
  })

  it('renders nothing in Responsive mode', () => {
    const { container } = render(<BrowserDeviceHeader device={null} onRotate={() => undefined} />)
    expect(container.textContent).toBe('')
  })
})

describe('device viewport and pointer mapping', () => {
  const session = { viewport: { current: { w: 900, h: 500 } } } as unknown as BrowserSession

  it('the surface session reports the device size, not the node size, while a device is active', () => {
    const dev = resolveDevice({ id: 'iphone-15-pro' })
    const { result, rerender } = renderHook(({ d }) => useDeviceSession(session, d), { initialProps: { d: dev } })
    expect(result.current.viewport.current).toEqual({ w: 393, h: 852 })
    rerender({ d: null })
    expect(result.current).toBe(session)
    expect(deviceStyle(dev)).toEqual({ '--device-w': 393, '--device-h': 852 })
  })

  it('maps a click on the letterboxed frame to device CSS px', () => {
    // Node body 900x500; the 393x852 frame letterboxes to height 500 -> width 230.6, centered at left (900-230.6)/2.
    const h = 500, w = (393 / 852) * h, left = 100 + (900 - w) / 2
    const rect = { left, top: 50, width: w, height: h }
    const center = mouseMsg('down', { clientX: left + w / 2, clientY: 50 + h / 2, button: 0, buttons: 1, pointerId: 1, pressure: 0.5, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }, rect, { w: 393, h: 852 }, 1)
    expect(center?.x).toBeCloseTo(196.5)
    expect(center?.y).toBeCloseTo(426)
    const corner = toPagePoint(rect, { x: left + w, y: 50 + h }, { w: 393, h: 852 })
    expect(corner?.x).toBeCloseTo(393)
    expect(corner?.y).toBeCloseTo(852)
  })
})

describe('device persistence on the board', () => {
  it('round-trips the device choice through the saved node, and absent stays absent', async () => {
    const { toFlow, toWsNode } = await import('./store')
    const n = { id: 'b', kind: 'browser' as const, x: 0, y: 0, device: { id: 'pixel-8', landscape: true } }
    expect(toWsNode(toFlow(n)).device).toEqual({ id: 'pixel-8', landscape: true })
    expect('device' in JSON.parse(JSON.stringify(toWsNode(toFlow({ id: 'b', kind: 'browser', x: 0, y: 0 }))))).toBe(false)
  })
})
