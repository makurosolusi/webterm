// Canvas wallpaper settings (Warp / iTerm2 style): plain default, solid color, two-stop gradient,
// or an uploaded image. Global value lives in `Settings.canvasBackground`; a workspace can override
// it in `Settings.canvasBackgroundByWorkspace[workspaceId]` (absent = "Same as global"). Stored in
// the settings JSON row, so it needs no SQLite migration.
//
// Values arrive over HTTP and can be hand-edited, so every field is normalized here: unknown mode
// -> default, bad color -> default color, numbers clamped to `CANVAS_BG_RANGES`.

export type CanvasBackgroundMode = 'default' | 'color' | 'gradient' | 'image'
export type CanvasImageFit = 'cover' | 'contain' | 'tile'
/** When moving media (video, animated WebP/GIF) plays: always, only while the window is focused, never. */
export type CanvasPlayback = 'always' | 'focused' | 'off'

/** Two-stop linear gradient; `angle` in CSS degrees. */
export interface CanvasGradient {
  from: string
  to: string
  angle: number
}

/** One canvas background (global or per-workspace). */
export interface CanvasBackground {
  mode: CanvasBackgroundMode
  /** `#rrggbb`, used by `color` mode. */
  color: string
  /** Used by `gradient` mode and by the optional image overlay. */
  gradient: CanvasGradient
  /** Stored image file name (`<uuid>.<ext>`) from the upload route; '' = none uploaded. */
  imageId: string
  /** CSS blur radius in px applied once to the wallpaper layer. */
  imageBlur: number
  /** Dark overlay opacity in percent (0 = none). */
  imageDim: number
  /** Paint the gradient over the image (at `IMAGE_GRADIENT_OVERLAY_OPACITY`). */
  imageGradientOverlay: boolean
  imageFit: CanvasImageFit
  /** True when the stored file moves (video, animated WebP, GIF); set by the server from the sniffed bytes. */
  imageAnimated: boolean
  /** Playback of moving media; ignored for still images. */
  playback: CanvasPlayback
}

export const CANVAS_BG_MODES: readonly CanvasBackgroundMode[] = ['default', 'color', 'gradient', 'image']
export const CANVAS_IMAGE_FITS: readonly CanvasImageFit[] = ['cover', 'contain', 'tile']
export const CANVAS_PLAYBACKS: readonly CanvasPlayback[] = ['always', 'focused', 'off']

/** Slider ranges; UI, normalizer and tests all read this table. */
export const CANVAS_BG_RANGES = {
  angle: { min: 0, max: 360, step: 1 },
  // Past 40px the image is an unrecognizable smear; blur cost also grows with the radius.
  imageBlur: { min: 0, max: 40, step: 1 },
  // 90% keeps a hint of the image; 100% would just be a black canvas.
  imageDim: { min: 0, max: 90, step: 1 },
} as const

/** Opacity of the gradient painted over an image when `imageGradientOverlay` is on. */
export const IMAGE_GRADIENT_OVERLAY_OPACITY = 0.5

/** Upload file name: server-generated uuid + whitelisted extension. Never a client name. */
export const CANVAS_IMAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|mp4|webm)$/

/** Upload cap for a wallpaper image, animated WebP/GIF included (server enforces it; the UI pre-checks it). */
export const MAX_CANVAS_IMAGE_BYTES = 25 * 1024 * 1024
/** Upload cap for a wallpaper video (MP4 / WebM). */
export const MAX_CANVAS_VIDEO_BYTES = 100 * 1024 * 1024

/** True when the stored file id is a video (the id's extension is server-chosen from the sniffed bytes). */
export const isCanvasVideoId = (id: string): boolean => id.endsWith('.mp4') || id.endsWith('.webm')

/** First bytes the sniffer needs: the RIFF/VP8X header, an MP4 brand or the WebM DocType. */
export const CANVAS_SNIFF_BYTES = 64

const RIFF_WEBP_VP8X = 12
const VP8X_FLAGS_OFFSET = 20
const VP8X_ANIMATION_FLAG = 0x02

/** True for a WebP whose VP8X header sets the animation flag (so the browser plays it as a clip). */
export function isAnimatedWebp(head: Uint8Array): boolean {
  if (head.length <= VP8X_FLAGS_OFFSET) return false
  const tag = (at: number): string => String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3])
  return tag(0) === 'RIFF' && tag(8) === 'WEBP' && tag(RIFF_WEBP_VP8X) === 'VP8X' && (head[VP8X_FLAGS_OFFSET] & VP8X_ANIMATION_FLAG) !== 0
}

/** Caps on the per-workspace map: it travels inside the 64 KiB settings PUT body. */
export const WORKSPACE_BACKGROUNDS_LIMITS = { entries: 100, idLength: 128 }

const HEX_RE = /^#[0-9a-f]{6}$/i

export const DEFAULT_CANVAS_BACKGROUND: CanvasBackground = {
  mode: 'default',
  color: '#1e1f24',
  gradient: { from: '#1b2234', to: '#2b1d33', angle: 135 },
  imageId: '',
  imageBlur: 0,
  imageDim: 40,
  imageGradientOverlay: false,
  imageFit: 'cover',
  imageAnimated: false,
  // Focused: a wallpaper that keeps moving in a window nobody is looking at only burns battery.
  playback: 'focused',
}

type RangeKey = keyof typeof CANVAS_BG_RANGES

/** Clamp to `CANVAS_BG_RANGES[key]`; non-finite -> `fallback`. */
export function clampCanvasBg(key: RangeKey, value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const { min, max } = CANVAS_BG_RANGES[key]
  return Math.min(Math.max(min, value), max)
}

const hex = (v: unknown, fallback: string): string => (typeof v === 'string' && HEX_RE.test(v) ? v.toLowerCase() : fallback)
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** Coerce any value into a valid `CanvasBackground`, field by field. */
export function normalizeCanvasBackground(v: unknown): CanvasBackground {
  const s = record(v)
  const g = record(s.gradient)
  const d = DEFAULT_CANVAS_BACKGROUND
  return {
    mode: oneOf(s.mode, CANVAS_BG_MODES, d.mode),
    color: hex(s.color, d.color),
    gradient: {
      from: hex(g.from, d.gradient.from),
      to: hex(g.to, d.gradient.to),
      angle: clampCanvasBg('angle', g.angle, d.gradient.angle),
    },
    imageId: typeof s.imageId === 'string' && CANVAS_IMAGE_ID_RE.test(s.imageId) ? s.imageId : '',
    imageBlur: clampCanvasBg('imageBlur', s.imageBlur, d.imageBlur),
    imageDim: clampCanvasBg('imageDim', s.imageDim, d.imageDim),
    imageGradientOverlay: typeof s.imageGradientOverlay === 'boolean' ? s.imageGradientOverlay : d.imageGradientOverlay,
    imageFit: oneOf(s.imageFit, CANVAS_IMAGE_FITS, d.imageFit),
    imageAnimated: typeof s.imageAnimated === 'boolean' ? s.imageAnimated : d.imageAnimated,
    playback: oneOf(s.playback, CANVAS_PLAYBACKS, d.playback),
  }
}

/** Normalize the per-workspace override map, dropping bad ids and capping its size. */
export function normalizeWorkspaceBackgrounds(v: unknown): Record<string, CanvasBackground> {
  const out: Record<string, CanvasBackground> = {}
  for (const [id, bg] of Object.entries(record(v))) {
    if (Object.keys(out).length >= WORKSPACE_BACKGROUNDS_LIMITS.entries) break
    if (!id || id.length > WORKSPACE_BACKGROUNDS_LIMITS.idLength) continue
    out[id] = normalizeCanvasBackground(bg)
  }
  return out
}

/** Settings slice needed to resolve a background. */
export interface CanvasBackgroundSettings {
  canvasBackground: CanvasBackground
  canvasBackgroundByWorkspace: Record<string, CanvasBackground>
}

/** Effective background for a workspace: its own override, else global, else default. */
export function resolveCanvasBackground(s: Partial<CanvasBackgroundSettings> | undefined, workspaceId?: string | null): CanvasBackground {
  const own = workspaceId ? s?.canvasBackgroundByWorkspace?.[workspaceId] : undefined
  return own ?? s?.canvasBackground ?? DEFAULT_CANVAS_BACKGROUND
}

/** Every image id referenced anywhere in settings (server uses it to decide what may be deleted). */
export function referencedImageIds(s: Partial<CanvasBackgroundSettings>): Set<string> {
  const ids = new Set<string>()
  const all = [s.canvasBackground, ...Object.values(s.canvasBackgroundByWorkspace ?? {})]
  for (const bg of all) if (bg?.imageId) ids.add(bg.imageId)
  return ids
}
