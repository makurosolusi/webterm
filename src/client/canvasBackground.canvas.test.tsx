/** @vitest-environment jsdom */
// Wallpaper on the REAL App canvas: layer behind a transparent pane, per-workspace override,
// adaptive dot color, and the silent default fallback when the image file is gone.
import { waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CANVAS_BACKGROUND, type CanvasBackground } from '../shared/canvasBackground.schema'
import { HARNESS_WS_ID, installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { DOT_ON_LIGHT } from './canvasBackground.style'

const IMG = '0f8b1c2a-1111-4222-8333-444455556666.png' // test-only
const bg = (p: Partial<CanvasBackground>): CanvasBackground => ({ ...DEFAULT_CANVAS_BACKGROUND, ...p })

/** `new Image()` that fails (file missing on disk) or loads, on the next microtask. */
function stubImage(outcome: 'load' | 'error'): void {
  // jsdom has no 2D canvas: the luminance sample is skipped (null context), not logged as an error.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_v: string) { queueMicrotask(() => (outcome === 'load' ? this.onload?.() : this.onerror?.())) }
  })
}

beforeAll(installCanvasDom)
afterEach(() => { unmountCanvas(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const layer = () => document.querySelector('[data-testid="canvas-wallpaper-base"]') as HTMLElement | null
const flow = () => document.querySelector('.react-flow') as HTMLElement

describe('canvas wallpaper', () => {
  it('default: no layer, pane keeps the theme background', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    expect(layer()).toBeNull()
    expect(flow().classList.contains('canvas--wallpaper')).toBe(false)
  })

  it('color: fixed layer behind a transparent pane, dots adapt to a light color', async () => {
    await mountCanvas({ nodes: [], dirs: {}, settings: { canvasBackground: bg({ mode: 'color', color: '#ece8df' }) } })
    await waitFor(() => expect(layer()).not.toBeNull())
    expect(layer()?.style.background).toContain('rgb(236, 232, 223)')
    expect(flow().classList.contains('canvas--wallpaper')).toBe(true)
    // Layer is a sibling BEFORE the pane, outside the transformed viewport: it never pans/zooms.
    expect(document.querySelector('.react-flow__viewport [data-testid="canvas-wallpaper"]')).toBeNull()
    const dots = document.querySelector('[data-testid="rf__background"]') as HTMLElement | null
    expect(dots?.style.getPropertyValue('--xy-background-pattern-color-props')).toBe(DOT_ON_LIGHT)
  })

  it('workspace override wins over global', async () => {
    await mountCanvas({
      nodes: [], dirs: {},
      settings: {
        canvasBackground: bg({ mode: 'color', color: '#111111' }),
        canvasBackgroundByWorkspace: { [HARNESS_WS_ID]: bg({ mode: 'gradient', gradient: { from: '#000000', to: '#ffffff', angle: 90 } }) },
      },
    })
    await waitFor(() => expect(layer()).not.toBeNull())
    expect(layer()?.style.background).toContain('linear-gradient(90deg')
  })

  it('image: renders the image layer when the file loads', async () => {
    stubImage('load')
    await mountCanvas({ nodes: [], dirs: {}, settings: { canvasBackground: bg({ mode: 'image', imageId: IMG, imageBlur: 8 }) } })
    await waitFor(() => expect(layer()?.style.backgroundImage).toContain(`/api/canvas-background/image/${IMG}`))
    expect(layer()?.style.filter).toBe('blur(8px)')
  })

  it('image file missing on disk: falls back to the default look, never a broken canvas', async () => {
    stubImage('error')
    await mountCanvas({ nodes: [], dirs: {}, settings: { canvasBackground: bg({ mode: 'image', imageId: IMG }) } })
    await waitFor(() => expect(flow().classList.contains('canvas--wallpaper')).toBe(false))
    expect(layer()).toBeNull()
  })
})
