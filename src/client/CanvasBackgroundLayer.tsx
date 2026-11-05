// Fixed wallpaper behind the React Flow pane: it does not pan or zoom with the board. Blur is one
// CSS filter on this layer (not per node). A missing image file falls back to the default look.
import { useEffect, useState } from 'react'
import type { CanvasBackground } from '../shared/canvasBackground.schema'
import { canvasImageUrl } from './canvasBackground.api'
import { backgroundLuminance, dotColorFor, layerStyles, rgbLuminance } from './canvasBackground.style'

/** Side of the downscaled canvas the average image color is sampled from. */
const SAMPLE_SIZE = 16

export type ImageStatus = 'none' | 'loading' | 'ok' | 'missing'

/** Average luminance of a loaded image, sampled once on a tiny canvas; null if unavailable. */
function sampleLuminance(img: HTMLImageElement): number | null {
  const canvas = document.createElement('canvas')
  canvas.width = SAMPLE_SIZE
  canvas.height = SAMPLE_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
  const px = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
  let r = 0, g = 0, b = 0
  const n = px.length / 4
  for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2] }
  return rgbLuminance(r / n, g / n, b / n)
}

/** Load `url` once: whether it exists, and its average luminance. */
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

/** Everything the canvas needs to paint one background. */
export interface WallpaperState {
  /** Background actually shown (image mode with a missing file is shown as default). */
  shown: CanvasBackground
  imageUrl: string | null
  imageStatus: ImageStatus
  imageLuminance: number | null
  dotColor: string
  /** True when a custom layer is painted (pane must be transparent). */
  active: boolean
}

/** Resolve image URL, probe it, and derive the dot color for `bg`. */
export function useWallpaper(bg: CanvasBackground): WallpaperState {
  const imageUrl = bg.mode === 'image' && bg.imageId ? canvasImageUrl(bg.imageId) : null
  const probe = useImageProbe(imageUrl)
  const usable = imageUrl !== null && probe.status !== 'missing'
  const shown: CanvasBackground = bg.mode === 'image' && !usable ? { ...bg, mode: 'default' } : bg
  return {
    shown,
    imageUrl: usable ? imageUrl : null,
    imageStatus: probe.status,
    imageLuminance: probe.luminance,
    dotColor: dotColorFor(backgroundLuminance(shown, probe.luminance)),
    active: shown.mode !== 'default',
  }
}

/** The wallpaper layers (base, dim, gradient overlay); nothing in default mode. */
export function CanvasBackgroundLayer({ bg, imageUrl, className = 'canvas-wallpaper' }: {
  bg: CanvasBackground
  imageUrl: string | null
  className?: string
}): React.JSX.Element | null {
  const styles = layerStyles(bg, imageUrl)
  if (!styles) return null
  return (
    <div className={className} data-testid="canvas-wallpaper" aria-hidden>
      <div className="canvas-wallpaper__base" data-testid="canvas-wallpaper-base" style={styles.base} />
      {styles.dim && <div className="canvas-wallpaper__fill" data-testid="canvas-wallpaper-dim" style={styles.dim} />}
      {styles.overlay && <div className="canvas-wallpaper__fill" data-testid="canvas-wallpaper-overlay" style={styles.overlay} />}
    </div>
  )
}
