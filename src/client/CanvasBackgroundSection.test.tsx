/** @vitest-environment jsdom */
// Settings > Canvas background: live preview, reset, contrast guard, missing-file notice,
// upload wiring, the one "This workspace: Same as all / Custom" choice, and a preset selected only on an exact match.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { DEFAULT_CANVAS_BACKGROUND, type CanvasBackground } from '../shared/canvasBackground.schema'
import { RECOMMENDED_IMAGE_DIM } from './canvasBackground.style'
import { CanvasBackgroundSection } from './CanvasBackgroundSection'
import { applySettingsPatch } from '../shared/settings.patch'

const IMG = '0f8b1c2a-1111-4222-8333-444455556666.png' // test-only
const bg = (p: Partial<CanvasBackground>): CanvasBackground => ({ ...DEFAULT_CANVAS_BACKGROUND, ...p })

/** Image stub; `load` also fakes a 2D context whose pixels are all `pixel`. */
function stubImage(outcome: 'load' | 'error', pixel = 255): void {
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_v: string) { queueMicrotask(() => (outcome === 'load' ? this.onload?.() : this.onerror?.())) }
  })
  const ctx = { drawImage: () => {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(pixel) }) }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
}

let latest: Settings = DEFAULT_SETTINGS
function Host({ initial, projectId }: { initial: Partial<Settings>; projectId?: string }) {
  const [s, setS] = useState<Settings>({ ...DEFAULT_SETTINGS, ...initial })
  latest = s
  return <CanvasBackgroundSection settings={s} projectId={projectId}
    onChange={(p) => setS((prev) => { latest = applySettingsPatch(prev, p); return latest })} />
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
/** Picks `name` in the segmented choice labelled `group`. */
const pick = (group: string, name: string): void => { fireEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name })) }
const picked = (group: string): string | null | undefined =>
  within(screen.getByRole('radiogroup', { name: group })).getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true')?.textContent
const previewBase = () => document.querySelector('[data-testid="canvas-background-preview"] [data-testid="canvas-wallpaper-base"]') as HTMLElement | null

describe('CanvasBackgroundSection', () => {
  it('applies a style immediately (live preview) and a preset', () => {
    render(<Host initial={{}} />)
    expect(previewBase()).toBeNull()
    pick('Background style', 'Solid color')
    expect(latest.canvasBackground.mode).toBe('color')
    expect(previewBase()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Midnight navy' }))
    expect(latest.canvasBackground.color).toBe('#141b2d')
    expect(previewBase()?.style.background).toContain('rgb(20, 27, 45)')
  })

  it('gradient angle slider writes the angle', () => {
    render(<Host initial={{ canvasBackground: bg({ mode: 'gradient' }) }} />)
    fireEvent.change(screen.getByLabelText('Gradient angle'), { target: { value: '200' } })
    expect(latest.canvasBackground.gradient.angle).toBe(200)
  })

  it('the Background style row\'s own Reset restores the default background (no separate reset button)', async () => {
    render(<Host initial={{ canvasBackground: bg({ mode: 'color', color: '#2a1e2e' }) }} />)
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull()
    expect(document.querySelector('.st-group-title')?.textContent).toBe('Canvas background')
    fireEvent.click(screen.getByRole('button', { name: 'Reset Setting: Background style' }))
    await waitFor(() => expect(latest.canvasBackground).toEqual(DEFAULT_CANVAS_BACKGROUND))
    expect(screen.queryByRole('button', { name: 'Reset Setting: Background style' })).toBeNull() // at the default: no dot, no Reset
  })

  it('warns on a bright, undimmed image; one click applies the recommended dim', async () => {
    stubImage('load', 250)
    render(<Host initial={{ canvasBackground: bg({ mode: 'image', imageId: IMG, imageDim: 0 }) }} />)
    const fix = await screen.findByRole('button', { name: 'Use recommended dim' })
    fireEvent.click(fix)
    expect(latest.canvasBackground.imageDim).toBe(RECOMMENDED_IMAGE_DIM)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use recommended dim' })).toBeNull())
  })

  it('no contrast warning for a dark image', async () => {
    stubImage('load', 20)
    render(<Host initial={{ canvasBackground: bg({ mode: 'image', imageId: IMG, imageDim: 0 }) }} />)
    await waitFor(() => expect(previewBase()).not.toBeNull())
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByRole('button', { name: 'Use recommended dim' })).toBeNull()
  })

  it('missing image file: notice in Settings, preview falls back to default', async () => {
    stubImage('error')
    render(<Host initial={{ canvasBackground: bg({ mode: 'image', imageId: IMG }) }} />)
    expect(await screen.findByText(/background image file is missing/)).toBeTruthy()
    expect(previewBase()).toBeNull()
  })

  it('upload posts the bytes for the scope and adopts the settings the server saved', async () => {
    stubImage('load', 20)
    const saved = { ...DEFAULT_SETTINGS, canvasBackground: bg({ mode: 'image', imageId: IMG }) }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(saved), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<Host initial={{ canvasBackground: bg({ mode: 'image' }) }} />)
    const file = new File([new Uint8Array([0x89, 0x50])], 'me.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('Image'), { target: { files: [file] } })
    await waitFor(() => expect(latest.canvasBackground.imageId).toBe(IMG))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.startsWith('/api/canvas-background/image')).toBe(true)
    expect(init.method).toBe('POST')
  })

  it('upload rejected by the server shows the reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 415 })))
    render(<Host initial={{ canvasBackground: bg({ mode: 'image' }) }} />)
    fireEvent.change(screen.getByLabelText('Image'), { target: { files: [new File(['x'], 'x.png')] } })
    expect((await screen.findByRole('alert')).textContent).toContain('Unsupported file')
  })

  it('This workspace: Same as all edits the shared background; Custom copies it and edits only this workspace', () => {
    render(<Host initial={{ canvasBackground: bg({ mode: 'color', color: '#17241e' }) }} projectId="w1" />)
    expect(screen.queryByLabelText('Edit background for')).toBeNull() // one choice, not two stacked selects
    expect(picked('This workspace')).toBe('Same as all workspaces')
    fireEvent.click(screen.getByRole('button', { name: 'Midnight navy' }))
    expect(latest.canvasBackground.color).toBe('#141b2d')
    pick('This workspace', 'Custom')
    expect(latest.canvasBackgroundByWorkspace.w1?.color).toBe('#141b2d')
    pick('Background style', 'Gradient')
    expect(latest.canvasBackgroundByWorkspace.w1?.mode).toBe('gradient')
    expect(latest.canvasBackground.mode).toBe('color')
  })

  it('back to Same as all drops the workspace override', async () => {
    render(<Host initial={{ canvasBackgroundByWorkspace: { w1: bg({ mode: 'color', color: '#2a1e2e' }) } }} projectId="w1" />)
    expect(picked('This workspace')).toBe('Custom')
    pick('This workspace', 'Same as all workspaces')
    await waitFor(() => expect(latest.canvasBackgroundByWorkspace.w1).toBeUndefined())
  })

  it('a gradient preset is selected only when its angle matches too', () => {
    const dusk = { from: '#1b2234', to: '#2b1d33', angle: 135 }
    render(<Host initial={{ canvasBackground: bg({ mode: 'gradient', gradient: dusk }) }} />)
    expect(screen.getByRole('button', { name: 'Dusk' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(screen.getByLabelText('Gradient angle'), { target: { value: '200' } })
    expect(screen.getByRole('button', { name: 'Dusk' }).getAttribute('aria-pressed')).toBe('false')
  })
})
