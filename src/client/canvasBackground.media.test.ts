// Pure rules for moving wallpapers and the pre-upload file look (no DOM needed beyond fake video elements).
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CANVAS_BACKGROUND, type CanvasBackground } from '../shared/canvasBackground.schema'
import { effectivePlayback, isMovingMedia, shouldAnimate } from './canvasBackground.media'
import {
  describeVideo, fileKindLabel, formatBytes, isVideoFile, kindLabel, maxBytesFor, probeVideoFile, videoWarnings, VIDEO_WARN_BYTES, type ProbeDeps,
} from './canvasBackground.precheck'

const UUID = '0f8b1c2a-1111-4222-8333-444455556666' // test-only
const bg = (p: Partial<CanvasBackground>): CanvasBackground => ({ ...DEFAULT_CANVAS_BACKGROUND, mode: 'image', ...p })

describe('isMovingMedia', () => {
  it('video, flagged animated webp and gif move; png/jpg/still webp and non-image modes do not', () => {
    expect(isMovingMedia(bg({ imageId: `${UUID}.mp4` }))).toBe(true)
    expect(isMovingMedia(bg({ imageId: `${UUID}.webm` }))).toBe(true)
    expect(isMovingMedia(bg({ imageId: `${UUID}.webp`, imageAnimated: true }))).toBe(true)
    expect(isMovingMedia(bg({ imageId: `${UUID}.gif` }))).toBe(true)
    expect(isMovingMedia(bg({ imageId: `${UUID}.webp` }))).toBe(false)
    expect(isMovingMedia(bg({ imageId: `${UUID}.png` }))).toBe(false)
    expect(isMovingMedia(bg({ imageId: `${UUID}.mp4`, mode: 'color' }))).toBe(false)
    expect(isMovingMedia(bg({ imageId: '' }))).toBe(false)
  })
})

describe('playback rules', () => {
  it('reduced motion forces Off unless the owner chose Always', () => {
    expect(effectivePlayback('focused', true)).toBe('off')
    expect(effectivePlayback('off', true)).toBe('off')
    expect(effectivePlayback('always', true)).toBe('always')
    expect(effectivePlayback('focused', false)).toBe('focused')
  })
  it('runs when always, or focused with an active window; never when off', () => {
    expect(shouldAnimate('always', false)).toBe(true)
    expect(shouldAnimate('focused', true)).toBe(true)
    expect(shouldAnimate('focused', false)).toBe(false)
    expect(shouldAnimate('off', true)).toBe(false)
  })
})

describe('file look before upload', () => {
  it('tells video from image by type or by name, with the matching cap', () => {
    expect(isVideoFile({ type: 'video/mp4', name: 'a' })).toBe(true)
    expect(isVideoFile({ type: '', name: 'clip.WEBM' })).toBe(true)
    expect(isVideoFile({ type: 'image/png', name: 'a.png' })).toBe(false)
    expect(maxBytesFor({ type: 'video/mp4', name: 'a' })).toBeGreaterThan(maxBytesFor({ type: 'image/png', name: 'a' }))
  })
  it('labels sizes and kinds', () => {
    expect(formatBytes(42 * 1024 * 1024)).toBe('42 MB')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(kindLabel(`${UUID}.mp4`)).toBe('MP4')
    expect(fileKindLabel({ type: 'video/webm', name: 'x' })).toBe('WebM')
    expect(fileKindLabel({ type: 'image/jpeg', name: 'x' })).toBe('JPEG')
    expect(fileKindLabel({ type: '', name: 'clip.mp4' })).toBe('MP4')
  })
  it('warns (never blocks) above 1080p or for a large file', () => {
    expect(videoWarnings({ width: 3840, height: 2160, duration: 10 }, 1)[0]).toContain('May use a lot of memory')
    expect(videoWarnings({ width: 1280, height: 720, duration: 10 }, VIDEO_WARN_BYTES + 1)[0]).toContain('May use a lot of memory')
    expect(videoWarnings({ width: 1920, height: 1080, duration: 10 }, 1024)).toEqual([])
    expect(describeVideo({ width: 1920, height: 1080, duration: 11.6 })).toBe('1920×1080 · 12 s')
  })
})

describe('probeVideoFile (fake video element: jsdom cannot play video)', () => {
  /** Invoke the handler the probe installed on the fake element. */
  const fire = (v: Partial<HTMLVideoElement>, handler: 'onloadedmetadata' | 'onerror'): void => { (v[handler] as ((e: Event) => void) | null | undefined)?.(new Event('x')) }
  const deps = (video: Partial<HTMLVideoElement>): ProbeDeps => ({
    createVideo: () => Object.assign(video, { removeAttribute: vi.fn(), load: vi.fn() }) as HTMLVideoElement,
    createObjectUrl: () => 'blob:x',
    revokeObjectUrl: vi.fn(),
  })
  it('resolves resolution and duration when metadata loads, and releases the object URL', async () => {
    const video: Partial<HTMLVideoElement> = { videoWidth: 1280, videoHeight: 720, duration: 8 }
    const d = deps(video)
    const p = probeVideoFile(new Blob(['x']), d)
    fire(video, 'onloadedmetadata')
    expect(await p).toEqual({ width: 1280, height: 720, duration: 8 })
    expect(d.revokeObjectUrl).toHaveBeenCalledWith('blob:x')
  })
  it('resolves null on a media error, on zero width (audio only) and on timeout', async () => {
    const a: Partial<HTMLVideoElement> = {}
    const pa = probeVideoFile(new Blob(['x']), deps(a))
    fire(a, 'onerror')
    expect(await pa).toBeNull()
    const b: Partial<HTMLVideoElement> = { videoWidth: 0, videoHeight: 0, duration: 3 }
    const pb = probeVideoFile(new Blob(['x']), deps(b))
    fire(b, 'onloadedmetadata')
    expect(await pb).toBeNull()
    expect(await probeVideoFile(new Blob(['x']), deps({}), 5)).toBeNull()
  })
})
