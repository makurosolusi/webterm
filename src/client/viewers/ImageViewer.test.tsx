/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageViewer } from './ImageViewer'
import { clampZoom, fitScale, stepZoom, wheelZoom, zoomLabel, ZOOM_MAX, ZOOM_MIN } from './imageZoom'

afterEach(cleanup)

function mount() {
  const onDims = vi.fn()
  const r = render(<ImageViewer src="/raw/pic.png" name="pic.png" onError={() => undefined} onDims={onDims} />)
  const img = screen.getByRole('img') as HTMLImageElement
  Object.defineProperty(img, 'naturalWidth', { value: 200, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: 100, configurable: true })
  fireEvent.load(img)
  const box = r.container.querySelector('.viewer-image') as HTMLDivElement
  return { img, box, onDims }
}

describe('imageZoom', () => {
  it('steps through the presets and clamps at the ends', () => {
    expect(stepZoom(1, 1)).toBe(1.5)
    expect(stepZoom(1, -1)).toBe(0.75)
    expect(stepZoom(0.43, 1)).toBe(0.5)
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
    expect(clampZoom(99)).toBe(ZOOM_MAX)
  })

  it('wheel up zooms in, down zooms out; fit never upscales', () => {
    expect(wheelZoom(1, -100)).toBeGreaterThan(1)
    expect(wheelZoom(1, 100)).toBeLessThan(1)
    expect(fitScale({ w: 100, h: 100 }, { w: 400, h: 400 })).toBe(1)
    expect(fitScale({ w: 1000, h: 500 }, { w: 400, h: 400 })).toBe(0.4)
    expect(zoomLabel(0.4)).toBe('40%')
  })
})

describe('ImageViewer', () => {
  it('reports natural size and keeps the canvas from taking wheel/drag', () => {
    const { box, onDims } = mount()
    expect(onDims).toHaveBeenCalledWith(200, 100)
    expect(box.classList.contains('nowheel')).toBe(true)
    expect(box.classList.contains('nodrag')).toBe(true)
  })

  it('100%, Zoom In, Zoom Out and Fit set the rendered size', () => {
    const { img } = mount()
    expect(img.style.width).toBe('')
    fireEvent.click(screen.getByRole('button', { name: '100%' }))
    expect(img.style.width).toBe('200px')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }))
    expect(img.style.width).toBe('300px')
    expect(img.style.imageRendering).toBe('pixelated')
    expect(screen.getByRole('toolbar', { name: 'Zoom' }).textContent).toContain('150%')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom Out' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom Out' }))
    expect(img.style.width).toBe('150px')
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }))
    expect(img.style.width).toBe('')
  })

  it('keys: 1 = 100%, + zooms in, 0 = fit', () => {
    const { img, box } = mount()
    fireEvent.keyDown(box, { key: '1' })
    expect(img.style.width).toBe('200px')
    fireEvent.keyDown(box, { key: '+' })
    expect(img.style.width).toBe('300px')
    fireEvent.keyDown(box, { key: '0' })
    expect(img.style.width).toBe('')
  })

  it('Ctrl/⌘+wheel (and pinch) zooms and is not passed on; a plain wheel is left to scroll', () => {
    const { img, box } = mount()
    Object.defineProperty(img, 'clientWidth', { value: 200, configurable: true })
    const zoomIn = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, cancelable: true, bubbles: true })
    act(() => { box.dispatchEvent(zoomIn) })
    expect(zoomIn.defaultPrevented).toBe(true)
    expect(parseFloat(img.style.width)).toBeGreaterThan(200)
    const plain = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true })
    box.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)
  })

  it('shows Loading… until the image decodes', () => {
    render(<ImageViewer src="/raw/x.png" name="x.png" onError={() => undefined} />)
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    fireEvent.load(screen.getByRole('img'))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
