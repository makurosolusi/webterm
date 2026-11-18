/** @vitest-environment jsdom */
// Moving wallpapers in the layer: the <video> element and its attributes, playback modes (focused pauses
// on blur/hidden and resumes, off shows the first frame, reduced motion), error fallback, one element and
// cleanup, luminance from the loaded video frame, and animated WebP shown as a still when it must not move.
// jsdom plays no media: play/pause/load are spies, so the REAL decode/loop/CPU behavior is not covered here.
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CANVAS_BACKGROUND, type CanvasBackground } from '../shared/canvasBackground.schema'
import { CanvasBackgroundLayer, useWallpaper } from './CanvasBackgroundLayer'

const UUID = '0f8b1c2a-1111-4222-8333-444455556666' // test-only
const MP4 = `${UUID}.mp4`
const WEBP = `${UUID}.webp`
const bg = (p: Partial<CanvasBackground>): CanvasBackground => ({ ...DEFAULT_CANVAS_BACKGROUND, mode: 'image', imageId: MP4, imageAnimated: true, ...p })

let play: ReturnType<typeof vi.spyOn>
let pause: ReturnType<typeof vi.spyOn>
let load: ReturnType<typeof vi.spyOn>
let focused = true
let hidden = false
let reduced = false

/** `window` focus/visibility as the layer reads them; `fire` dispatches the matching event. */
function setWindow(next: { focused?: boolean; hidden?: boolean }, fire: 'blur' | 'focus' | 'visibilitychange'): void {
  focused = next.focused ?? focused
  hidden = next.hidden ?? hidden
  act(() => { (fire === 'visibilitychange' ? document : window).dispatchEvent(new Event(fire)) })
}

beforeEach(() => {
  focused = true; hidden = false; reduced = false
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce'), addEventListener: () => undefined, removeEventListener: () => undefined }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const url = (id: string): string => `/api/canvas-background/image/${id}`
const video = (): HTMLVideoElement | null => document.querySelector('video')
const base = (): HTMLElement => document.querySelector('[data-testid="canvas-wallpaper-base"]') as HTMLElement

describe('video wallpaper', () => {
  it('renders ONE muted, looping, inline, non-interactive video with object-fit cover, no blur, dim kept', () => {
    render(<CanvasBackgroundLayer bg={bg({ imageBlur: 12, imageDim: 30 })} imageUrl={url(MP4)} />)
    expect(document.querySelectorAll('video')).toHaveLength(1)
    const v = video()!
    expect(v.getAttribute('src')).toBe(url(MP4))
    expect([v.autoplay, v.muted, v.loop, v.playsInline, v.preload]).toEqual([true, true, true, true, 'auto'])
    expect(v.hasAttribute('disablepictureinpicture')).toBe(true)
    expect(v.style.objectFit).toBe('cover')
    expect(v.style.pointerEvents).toBe('none')
    expect(base().style.filter).toBe('') // blur is never applied to video
    expect(base().style.backgroundImage).toBe('')
    expect(document.querySelector('[data-testid="canvas-wallpaper-dim"]')).not.toBeNull()
    expect(document.querySelector('.canvas-wallpaper')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('focused: pauses when the window loses focus or the tab hides, resumes when it returns', () => {
    render(<CanvasBackgroundLayer bg={bg({ playback: 'focused' })} imageUrl={url(MP4)} />)
    expect(play).toHaveBeenCalled()
    pause.mockClear(); play.mockClear()
    setWindow({ focused: false }, 'blur')
    expect(pause).toHaveBeenCalled()
    setWindow({ focused: true }, 'focus')
    expect(play).toHaveBeenCalled()
    pause.mockClear(); play.mockClear()
    setWindow({ hidden: true }, 'visibilitychange')
    expect(pause).toHaveBeenCalled()
    setWindow({ hidden: false }, 'visibilitychange')
    expect(play).toHaveBeenCalled()
  })

  it('always: keeps playing through blur and hidden', () => {
    render(<CanvasBackgroundLayer bg={bg({ playback: 'always' })} imageUrl={url(MP4)} />)
    pause.mockClear()
    setWindow({ focused: false, hidden: true }, 'blur')
    expect(pause).not.toHaveBeenCalled()
  })

  it('off: paused on the first frame (rewound), never plays', () => {
    const { rerender } = render(<CanvasBackgroundLayer bg={bg({ playback: 'always' })} imageUrl={url(MP4)} />)
    video()!.currentTime = 0
    Object.defineProperty(video()!, 'currentTime', { configurable: true, writable: true, value: 7 })
    play.mockClear()
    rerender(<CanvasBackgroundLayer bg={bg({ playback: 'off' })} imageUrl={url(MP4)} />)
    expect(pause).toHaveBeenCalled()
    expect(video()!.currentTime).toBe(0)
    expect(play).not.toHaveBeenCalled()
  })

  it('reduced motion: focused behaves as off, an explicit Always still plays', () => {
    reduced = true
    const { unmount } = render(<CanvasBackgroundLayer bg={bg({ playback: 'focused' })} imageUrl={url(MP4)} />)
    expect(play).not.toHaveBeenCalled()
    expect(pause).toHaveBeenCalled()
    unmount()
    play.mockClear()
    render(<CanvasBackgroundLayer bg={bg({ playback: 'always' })} imageUrl={url(MP4)} />)
    expect(play).toHaveBeenCalled()
  })

  it('unmount and replacing the wallpaper release the decoder (src emptied + load) and leave no extra video', () => {
    const { rerender, unmount } = render(<CanvasBackgroundLayer bg={bg({})} imageUrl={url(MP4)} />)
    const first = video()!
    rerender(<CanvasBackgroundLayer bg={bg({ mode: 'color' })} imageUrl={null} />)
    expect(document.querySelectorAll('video')).toHaveLength(0)
    expect(first.getAttribute('src')).toBe('')
    expect(load).toHaveBeenCalled()
    rerender(<CanvasBackgroundLayer bg={bg({})} imageUrl={url(MP4)} />)
    expect(document.querySelectorAll('video')).toHaveLength(1)
    load.mockClear()
    unmount()
    expect(load).toHaveBeenCalled()
  })

  it('a rejected play() (not an abort) and a media error both report failure; AbortError does not', async () => {
    const onError = vi.fn()
    play.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'AbortError' }))
    const { unmount } = render(<CanvasBackgroundLayer bg={bg({})} imageUrl={url(MP4)} onVideoError={onError} />)
    await Promise.resolve()
    expect(onError).not.toHaveBeenCalled()
    unmount()
    play.mockRejectedValueOnce(Object.assign(new Error('policy'), { name: 'NotAllowedError' }))
    render(<CanvasBackgroundLayer bg={bg({})} imageUrl={url(MP4)} onVideoError={onError} />)
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    fireEvent.error(video()!)
    expect(onError).toHaveBeenCalledTimes(2)
  })
})

/** The real wiring: hook + layer, as the canvas and the Settings preview use them. */
function Wired({ value }: { value: CanvasBackground }): React.JSX.Element {
  const w = useWallpaper(value)
  return (
    <>
      <CanvasBackgroundLayer bg={w.shown} imageUrl={w.imageUrl} onVideoLoaded={w.onVideoLoaded} onVideoError={w.onVideoError} />
      <output data-testid="out" data-active={String(w.active)} data-failed={String(w.videoFailed)} data-lum={String(w.imageLuminance)} data-dot={w.dotColor} />
    </>
  )
}
const out = (): HTMLElement => document.querySelector('[data-testid="out"]') as HTMLElement

describe('video wallpaper wiring', () => {
  it('a broken video falls back to the default look and says so (no layer, pane transparent flag off)', async () => {
    render(<Wired value={bg({})} />)
    expect(out().dataset.active).toBe('true')
    fireEvent.error(video()!)
    await waitFor(() => expect(out().dataset.failed).toBe('true'))
    expect(out().dataset.active).toBe('false')
    expect(document.querySelector('[data-testid="canvas-wallpaper"]')).toBeNull()
    expect(video()).toBeNull()
  })

  it('luminance comes from the loaded video frame and drives the dot color', async () => {
    const ctx = { drawImage: vi.fn(), getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }) }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    render(<Wired value={bg({ imageDim: 0 })} />)
    expect(out().dataset.lum).toBe('null')
    fireEvent.loadedData(video()!)
    await waitFor(() => expect(Number(out().dataset.lum)).toBeCloseTo(1, 1))
    expect(ctx.drawImage).toHaveBeenCalledWith(video(), 0, 0, 16, 16)
    expect(out().dataset.dot).toContain('rgba(0, 0, 0') // bright frame -> dark dots
  })

  it('a failed luminance sample keeps the video playing (safe)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => { throw new Error('tainted') })
    render(<Wired value={bg({})} />)
    fireEvent.loadedData(video()!)
    await waitFor(() => expect(out().dataset.failed).toBe('false'))
    expect(video()).not.toBeNull()
    expect(out().dataset.lum).toBe('null')
  })
})

describe('animated image wallpaper', () => {
  /** `new Image()` that loads on the next microtask, with a 2D context that returns a fixed data URL. */
  function stubImage(): void {
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      naturalWidth = 4000
      naturalHeight = 2000
      set src(_v: string) { queueMicrotask(() => this.onload?.()) }
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: () => undefined } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,STILL')
  }
  const animated = (p: Partial<CanvasBackground>): CanvasBackground => bg({ imageId: WEBP, imageAnimated: true, ...p })

  it('always: the animated file itself is the background (browser plays it); blur still applies', () => {
    render(<CanvasBackgroundLayer bg={animated({ playback: 'always', imageBlur: 6 })} imageUrl={url(WEBP)} />)
    expect(base().style.backgroundImage).toContain(url(WEBP))
    expect(base().style.filter).toBe('blur(6px)')
    expect(base().dataset.still).toBeUndefined()
  })

  it('off: one still frame (drawn to a canvas, capped to 1920 wide) replaces the animation', async () => {
    stubImage()
    render(<CanvasBackgroundLayer bg={animated({ playback: 'off' })} imageUrl={url(WEBP)} />)
    await waitFor(() => expect(base().dataset.still).toBe('true'))
    expect(base().style.backgroundImage).toContain('data:image/jpeg;base64,STILL')
    expect(base().style.backgroundImage).not.toContain(url(WEBP))
  })

  it('reduced motion and an unfocused window freeze it too; focus brings the animation back', async () => {
    stubImage()
    reduced = true
    const { unmount } = render(<CanvasBackgroundLayer bg={animated({ playback: 'focused' })} imageUrl={url(WEBP)} />)
    await waitFor(() => expect(base().dataset.still).toBe('true'))
    unmount()
    reduced = false
    render(<CanvasBackgroundLayer bg={animated({ playback: 'focused' })} imageUrl={url(WEBP)} />)
    expect(base().style.backgroundImage).toContain(url(WEBP))
    setWindow({ focused: false }, 'blur')
    await waitFor(() => expect(base().dataset.still).toBe('true'))
    setWindow({ focused: true }, 'focus')
    expect(base().style.backgroundImage).toContain(url(WEBP))
  })

  it('no still frame possible (no 2D context): shows no moving picture, keeps the layer', async () => {
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_v: string) { queueMicrotask(() => this.onload?.()) }
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    render(<CanvasBackgroundLayer bg={animated({ playback: 'off' })} imageUrl={url(WEBP)} />)
    await waitFor(() => expect(base().dataset.still).toBe('true'))
    expect(base().style.backgroundImage).toBe('')
    expect(document.querySelector('[data-testid="canvas-wallpaper"]')).not.toBeNull()
  })

  it('a still image ignores playback entirely', () => {
    render(<CanvasBackgroundLayer bg={bg({ imageId: `${UUID}.png`, imageAnimated: false, playback: 'off' })} imageUrl={url(`${UUID}.png`)} />)
    expect(base().style.backgroundImage).toContain(`${UUID}.png`)
    expect(video()).toBeNull()
  })
})
