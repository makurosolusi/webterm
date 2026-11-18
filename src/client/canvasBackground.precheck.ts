// Client-side look at a file before it is uploaded: kind, size label, and for video a metadata load in a
// hidden element (so a file this browser cannot play is refused with a clear message, not uploaded).
// The server stays the authority (magic bytes, caps); this only saves a round trip and gives context.
import { MAX_CANVAS_IMAGE_BYTES, MAX_CANVAS_VIDEO_BYTES } from '../shared/canvasBackground.schema'

const MIB = 1024 * 1024
/** Warn (not block) above this width: a 4K video decodes into a lot of memory. */
export const VIDEO_WARN_WIDTH = 1920
/** Warn (not block) above this file size. */
export const VIDEO_WARN_BYTES = 50 * MIB
/** How long a file may take to report its metadata before it counts as unplayable. */
export const VIDEO_METADATA_TIMEOUT_MS = 10_000

export const VIDEO_UNPLAYABLE_MESSAGE = "This video can't be played here. Use an H.264 MP4 or a WebM file."
export const MEMORY_WARNING = 'May use a lot of memory on this machine.'

/** True for a video file (by MIME type, or by name when the OS gives no type). */
export const isVideoFile = (file: Pick<File, 'type' | 'name'>): boolean => file.type.startsWith('video/') || /\.(mp4|webm)$/i.test(file.name)

/** Upload cap that applies to `file` (video and image caps differ). */
export const maxBytesFor = (file: Pick<File, 'type' | 'name'>): number => (isVideoFile(file) ? MAX_CANVAS_VIDEO_BYTES : MAX_CANVAS_IMAGE_BYTES)

/** '42 MB' / '640 KB'. */
export function formatBytes(bytes: number): string {
  return bytes >= MIB ? `${Math.round(bytes / MIB)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Label of a picked file from its MIME type, else its name ('MP4', 'WebM', 'PNG' ...). */
export function fileKindLabel(file: Pick<File, 'type' | 'name'>): string {
  const sub = file.type.split('/')[1] ?? ''
  return kindLabel(`.${sub === 'jpeg' ? 'jpg' : sub || file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()}`)
}

/** 'MP4' for `<uuid>.mp4`, 'WebP' for `.webp` ... from the stored id's extension. */
export function kindLabel(imageId: string): string {
  const ext = imageId.slice(imageId.lastIndexOf('.') + 1)
  return ({ png: 'PNG', jpg: 'JPEG', webp: 'WebP', gif: 'GIF', mp4: 'MP4', webm: 'WebM' } as Record<string, string>)[ext] ?? ext.toUpperCase()
}

export interface VideoInfo { width: number; height: number; duration: number }

/** Browser pieces the metadata probe needs; replaceable so a test can fake them (jsdom plays no video). */
export interface ProbeDeps {
  createVideo: () => HTMLVideoElement
  createObjectUrl: (file: Blob) => string
  revokeObjectUrl: (url: string) => void
}

const realDeps: ProbeDeps = {
  createVideo: () => document.createElement('video'),
  createObjectUrl: (f) => URL.createObjectURL(f),
  revokeObjectUrl: (u) => URL.revokeObjectURL(u),
}

/** Resolution and duration of a video file, or null when this browser cannot load it. */
export function probeVideoFile(file: Blob, deps: ProbeDeps = realDeps, timeoutMs = VIDEO_METADATA_TIMEOUT_MS): Promise<VideoInfo | null> {
  return new Promise((resolve) => {
    const video = deps.createVideo()
    const url = deps.createObjectUrl(file)
    const finish = (info: VideoInfo | null): void => {
      clearTimeout(timer)
      video.onloadedmetadata = null
      video.onerror = null
      video.removeAttribute('src')
      video.load()
      deps.revokeObjectUrl(url)
      resolve(info)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => finish(video.videoWidth > 0 ? { width: video.videoWidth, height: video.videoHeight, duration: video.duration } : null)
    video.onerror = () => finish(null)
    video.src = url
  })
}

/** Non-blocking warnings for a playable video. */
export function videoWarnings(info: VideoInfo, bytes: number): string[] {
  const out: string[] = []
  if (info.width > VIDEO_WARN_WIDTH) out.push(`${info.width}×${info.height} is larger than 1080p. ${MEMORY_WARNING}`)
  else if (bytes > VIDEO_WARN_BYTES) out.push(`${formatBytes(bytes)} is a large file. ${MEMORY_WARNING}`)
  return out
}

/** '1920×1080 · 12 s'. */
export function describeVideo(info: VideoInfo): string {
  const seconds = Number.isFinite(info.duration) ? ` · ${Math.round(info.duration)} s` : ''
  return `${info.width}×${info.height}${seconds}`
}
