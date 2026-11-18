// Fixed wallpaper behind the React Flow pane: it does not pan or zoom with the board. Blur is one
// CSS filter on this layer (not per node) and is never applied to video. A missing image file or an
// unplayable video falls back to the default look. Moving media (video, animated WebP/GIF) follows
// the background's playback mode; a paused animation shows one still frame.
import { useEffect, useState } from 'react'
import { isCanvasVideoId, type CanvasBackground } from '../shared/canvasBackground.schema'
import { canvasImageUrl } from './canvasBackground.api'
import { effectivePlayback, isMovingMedia, shouldAnimate } from './canvasBackground.media'
import { useWindowActive, usePrefersReducedMotion } from './canvasBackground.motion'
import { captureStill, sampleLuminance } from './canvasBackground.sample'
import { backgroundLuminance, dotColorFor, layerStyles } from './canvasBackground.style'
import { CanvasBackgroundVideo } from './CanvasBackgroundVideo'

export type ImageStatus = 'none' | 'loading' | 'ok' | 'missing'

/** Load `url` once: whether it exists, and its average luminance (first frame of an animation). */
export function useImageProbe(url: string | null): { status: ImageStatus; luminance: number | null } {
  const [state, setState] = useState<{ url: string | null; status: ImageStatus; luminance: number | null }>({ url: null, status: 'none', luminance: null })
  useEffect(() => {
    if (!url) return
    let alive = true
    const img = new Image()
    img.onload = () => {
      if (!alive) return
      let luminance: number | null = null
      try {
        luminance = sampleLuminance(img)
      } catch (err) {
        // Sampling is a nicety (dot color, contrast hint); the wallpaper itself still works.
        console.warn('canvas background: image luminance sample failed', err)
      }
      setState({ url, status: 'ok', luminance })
    }
    img.onerror = () => { if (alive) setState({ url, status: 'missing', luminance: null }) }
    img.src = url
    return () => { alive = false }
  }, [url])
  if (!url) return { status: 'none', luminance: null }
  return state.url === url ? state : { status: 'loading', luminance: null }
}

/** Still frame of an animated image while it must not move; `ready` false until it is drawn (or failed). */
function useStillFrame(url: string | null, wanted: boolean): { still: string | null; ready: boolean } {
  const [state, setState] = useState<{ url: string; still: string | null } | null>(null)
  useEffect(() => {
    if (!url || !wanted) return
    let alive = true
    const img = new Image()
    const done = (still: string | null): void => { if (alive) setState({ url, still }) }
    img.onload = () => {
      try {
        done(captureStill(img))
      } catch (err) {
        // No still frame (tainted canvas, huge image): the layer shows no picture rather than a moving one.
        console.warn('canvas background: still frame capture failed', err)
        done(null)
      }
    }
    img.onerror = () => done(null)
    img.src = url
    return () => { alive = false }
  }, [url, wanted])
  const mine = state?.url === url ? state : null
  return { still: mine?.still ?? null, ready: mine !== null }
}

/** Everything the canvas needs to paint one background. */
export interface WallpaperState {
  /** Background actually shown (image mode with a missing file or a broken video is shown as default). */
  shown: CanvasBackground
  imageUrl: string | null
  imageStatus: ImageStatus
  imageLuminance: number | null
  dotColor: string
  /** True when a custom layer is painted (pane must be transparent). */
  active: boolean
  /** The video could not be played (codec, decode or autoplay error); the default look is shown. */
  videoFailed: boolean
  /** Hand both to the `CanvasBackgroundLayer` that renders `shown`. */
  onVideoLoaded: (luminance: number | null) => void
  onVideoError: () => void
}

/** Resolve image URL, probe it (an image here, the layer's own `<video>` for video), and derive the dot color for `bg`. */
export function useWallpaper(bg: CanvasBackground): WallpaperState {
  const imageUrl = bg.mode === 'image' && bg.imageId ? canvasImageUrl(bg.imageId) : null
  const isVideo = bg.mode === 'image' && isCanvasVideoId(bg.imageId)
  const probe = useImageProbe(isVideo ? null : imageUrl)
  const [video, setVideo] = useState<{ url: string; failed: boolean; luminance: number | null } | null>(null)
  const mine = isVideo && video?.url === imageUrl ? video : null
  const videoFailed = mine?.failed === true
  const usable = imageUrl !== null && probe.status !== 'missing' && !videoFailed
  const shown: CanvasBackground = bg.mode === 'image' && !usable ? { ...bg, mode: 'default' } : bg
  const luminance = isVideo ? mine?.luminance ?? null : probe.luminance
  return {
    shown,
    imageUrl: usable ? imageUrl : null,
    imageStatus: isVideo ? (mine ? (videoFailed ? 'missing' : 'ok') : 'loading') : probe.status,
    imageLuminance: luminance,
    dotColor: dotColorFor(backgroundLuminance(shown, luminance)),
    active: shown.mode !== 'default',
    videoFailed,
    onVideoLoaded: (lum) => { if (imageUrl) setVideo({ url: imageUrl, failed: false, luminance: lum }) },
    onVideoError: () => { if (imageUrl) setVideo({ url: imageUrl, failed: true, luminance: null }) },
  }
}

interface LayerProps {
  bg: CanvasBackground
  imageUrl: string | null
  className?: string
  onVideoLoaded?: (luminance: number | null) => void
  onVideoError?: () => void
}

const noop = (): void => undefined

/** The wallpaper layers (base, dim, gradient overlay); nothing in default mode. */
export function CanvasBackgroundLayer({ bg, imageUrl, className = 'canvas-wallpaper', onVideoLoaded = noop, onVideoError = noop }: LayerProps): React.JSX.Element | null {
  const reduced = usePrefersReducedMotion()
  const windowActive = useWindowActive()
  const playback = effectivePlayback(bg.playback, reduced)
  const animate = shouldAnimate(playback, windowActive)
  const video = imageUrl !== null && isCanvasVideoId(bg.imageId)
  const animatedImage = imageUrl !== null && !video && isMovingMedia(bg)
  const frozen = animatedImage && !animate
  const { still, ready } = useStillFrame(imageUrl, frozen)
  const picture = frozen ? still : imageUrl
  const styles = layerStyles(bg, picture ?? imageUrl, frozen && picture === null)
  if (!styles) return null
  return (
    <div className={className} data-testid="canvas-wallpaper" aria-hidden>
      <div className="canvas-wallpaper__base" data-testid="canvas-wallpaper-base" data-still={frozen && ready ? 'true' : undefined} style={styles.base}>
        {video && imageUrl && (
          <CanvasBackgroundVideo url={imageUrl} fit={bg.imageFit === 'contain' ? 'contain' : 'cover'} playing={animate} rewind={playback === 'off'}
            onLoaded={onVideoLoaded} onError={onVideoError} />
        )}
      </div>
      {styles.dim && <div className="canvas-wallpaper__fill" data-testid="canvas-wallpaper-dim" style={styles.dim} />}
      {styles.overlay && <div className="canvas-wallpaper__fill" data-testid="canvas-wallpaper-overlay" style={styles.overlay} />}
    </div>
  )
}
