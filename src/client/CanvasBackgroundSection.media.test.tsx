/** @vitest-environment jsdom */
// Settings > Canvas background for moving media: accepted types, the Playback select (moving media only),
// blur disabled for video, pre-upload checks (unplayable / too large / resolution warning), server errors.
// jsdom plays no video: the metadata probe is replaced by a stub, so real decoding is not covered.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { applySettingsPatch } from '../shared/settings.patch'
import { DEFAULT_CANVAS_BACKGROUND, MAX_CANVAS_IMAGE_BYTES, MAX_CANVAS_VIDEO_BYTES, type CanvasBackground } from '../shared/canvasBackground.schema'
import { CanvasBackgroundSection } from './CanvasBackgroundSection'
import * as precheck from './canvasBackground.precheck'
import { searchSettings } from './settings.search'

const UUID = '0f8b1c2a-1111-4222-8333-444455556666' // test-only
const bg = (p: Partial<CanvasBackground>): CanvasBackground => ({ ...DEFAULT_CANVAS_BACKGROUND, mode: 'image', ...p })

let latest: Settings = DEFAULT_SETTINGS
function Host({ initial }: { initial: Partial<Settings> }): React.JSX.Element {
  const [s, setS] = useState<Settings>({ ...DEFAULT_SETTINGS, ...initial })
  latest = s
  return <CanvasBackgroundSection settings={s} onChange={(p) => setS((prev) => { latest = applySettingsPatch(prev, p); return latest })} />
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const withBg = (p: Partial<CanvasBackground>): { canvasBackground: CanvasBackground } => ({ canvasBackground: bg(p) })
const fileInput = (): HTMLInputElement => screen.getByLabelText('Image or video') as HTMLInputElement
const video = (name = 'loop.mp4', size = 1024): File => {
  const f = new File(['x'], name, { type: name.endsWith('webm') ? 'video/webm' : 'video/mp4' })
  Object.defineProperty(f, 'size', { value: size })
  return f
}
const saved = (p: Partial<CanvasBackground>): Settings => ({ ...DEFAULT_SETTINGS, canvasBackground: bg(p) })

describe('Canvas background: image or video', () => {
  it('accepts png, jpeg, webp, gif, mp4 and webm, and tells where to get free clips', () => {
    render(<Host initial={withBg({})} />)
    expect(fileInput().accept).toBe('image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm')
    expect(screen.getByText(/Pexels, Pixabay/)).toBeTruthy()
    expect(screen.getByText(/25 MB/)).toBeTruthy()
    expect(screen.getByText(/100 MB/)).toBeTruthy()
  })

  it('Playback select shows only for moving media and writes the choice', () => {
    const { unmount } = render(<Host initial={withBg({ imageId: `${UUID}.png` })} />)
    expect(screen.queryByLabelText('Playback')).toBeNull()
    unmount()
    render(<Host initial={withBg({ imageId: `${UUID}.mp4`, imageAnimated: true })} />)
    const select = screen.getByLabelText('Playback') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Always', 'When focused', 'Off'])
    expect(select.value).toBe('focused')
    fireEvent.change(select, { target: { value: 'off' } })
    expect(latest.canvasBackground.playback).toBe('off')
  })

  it('animated webp also gets Playback, and blur on it warns about CPU', () => {
    render(<Host initial={withBg({ imageId: `${UUID}.webp`, imageAnimated: true, imageBlur: 5 })} />)
    expect(screen.getByLabelText('Playback')).toBeTruthy()
    expect(screen.getByText('Blur on an animated image uses more CPU')).toBeTruthy()
    expect((screen.getByLabelText('Blur') as HTMLInputElement).disabled).toBe(false)
  })

  it('video: blur is disabled with a hint, dim still works, the media info shows its kind', () => {
    render(<Host initial={withBg({ imageId: `${UUID}.mp4`, imageAnimated: true, imageBlur: 9 })} />)
    expect((screen.getByLabelText('Blur') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText('Blur is not applied to video')).toBeTruthy()
    expect((screen.getByLabelText('Dim') as HTMLInputElement).disabled).toBe(false)
    expect(screen.getByTestId('cbg-media-info').textContent).toBe('MP4')
    expect(document.querySelectorAll('[data-testid="canvas-background-preview"] video')).toHaveLength(1)
  })

  it('uploads a playable video, shows "MP4 · size · resolution", and warns above 1080p without blocking', async () => {
    vi.spyOn(precheck, 'probeVideoFile').mockResolvedValue({ width: 3840, height: 2160, duration: 12 })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(saved({ imageId: `${UUID}.mp4`, imageAnimated: true })), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<Host initial={withBg({})} />)
    fireEvent.change(fileInput(), { target: { files: [video('loop.mp4', 42 * 1024 * 1024)] } })
    await waitFor(() => expect(latest.canvasBackground.imageId).toBe(`${UUID}.mp4`))
    expect(latest.canvasBackground.imageAnimated).toBe(true)
    expect((await screen.findByTestId('cbg-media-info')).textContent).toBe('MP4 · 42 MB · 3840×2160 · 12 s')
    expect(screen.getByText(/May use a lot of memory on this machine/)).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a video this browser cannot load is refused with a clear message and never uploaded', async () => {
    vi.spyOn(precheck, 'probeVideoFile').mockResolvedValue(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<Host initial={withBg({})} />)
    fireEvent.change(fileInput(), { target: { files: [video()] } })
    expect((await screen.findByRole('alert')).textContent).toBe("This video can't be played here. Use an H.264 MP4 or a WebM file.")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('size caps are checked before reading the file: video 100 MB, image 25 MB', async () => {
    const probe = vi.spyOn(precheck, 'probeVideoFile')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<Host initial={withBg({})} />)
    fireEvent.change(fileInput(), { target: { files: [video('big.mp4', MAX_CANVAS_VIDEO_BYTES + 1)] } })
    expect((await screen.findByRole('alert')).textContent).toContain('Video is too large (max 100 MB)')
    const png = new File(['x'], 'big.png', { type: 'image/png' })
    Object.defineProperty(png, 'size', { value: MAX_CANVAS_IMAGE_BYTES + 1 })
    fireEvent.change(fileInput(), { target: { files: [png] } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Image is too large (max 25 MB)'))
    expect(probe).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps server 413 and 415 to friendly messages', async () => {
    vi.spyOn(precheck, 'probeVideoFile').mockResolvedValue({ width: 1280, height: 720, duration: 5 })
    render(<Host initial={withBg({})} />)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 413 })))
    fireEvent.change(fileInput(), { target: { files: [video()] } })
    expect((await screen.findByRole('alert')).textContent).toContain('File is too large')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 415 })))
    fireEvent.change(fileInput(), { target: { files: [video('b.mp4')] } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Unsupported file. Use PNG, JPEG, WebP, GIF, MP4 or WebM.'))
  })

  it('a stored video the canvas cannot play shows the message and the default look in the preview', async () => {
    render(<Host initial={withBg({ imageId: `${UUID}.mp4`, imageAnimated: true })} />)
    fireEvent.error(document.querySelector('video')!)
    const alert = await screen.findByRole('alert')
    expect(within(alert.parentElement as HTMLElement).getAllByText("This video can't be played here. Use an H.264 MP4 or a WebM file.").length).toBeGreaterThan(0)
    expect(document.querySelector('[data-testid="canvas-background-preview"] video')).toBeNull()
  })

  it('Settings search finds it by "background video" and "wallpaper"', () => {
    for (const q of ['background video', 'wallpaper']) {
      expect(searchSettings(q).some((g) => g.entries.some((e) => e.field === 'canvasBackground'))).toBe(true)
    }
  })
})
