// Pure styling for the canvas wallpaper: luminance -> dot grid color, contrast guard, and the CSS
// of each wallpaper layer. No DOM, so it is unit-tested in node-env.
import type { CSSProperties } from 'react'
import { IMAGE_GRADIENT_OVERLAY_OPACITY, isCanvasVideoId, type CanvasBackground, type CanvasGradient } from '../shared/canvasBackground.schema'

/** Above this relative luminance the background counts as light and gets dark dots. */
export const LIGHT_BACKGROUND_LUMINANCE = 0.4
export const DOT_ON_LIGHT = 'rgba(0, 0, 0, 0.3)'
export const DOT_ON_DARK = 'rgba(255, 255, 255, 0.18)'
/** Default theme dot color (today's look). */
export const DEFAULT_DOT = 'var(--canvas-dot)'
/** Image luminance assumed before the sample is ready (mid-grey, so dots stay visible). */
export const UNKNOWN_IMAGE_LUMINANCE = 0.5
/** Image luminance AFTER dim above which the Settings contrast warning shows. */
export const BRIGHT_IMAGE_LUMINANCE = 0.3
/** Dim the warning's one-click fix applies: enough that even a white image ends at `BRIGHT_IMAGE_LUMINANCE`. */
export const RECOMMENDED_IMAGE_DIM = 70

/** WCAG relative luminance (0..1) of `#rrggbb`. */
export function hexLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return rgbLuminance((n >> 16) & 255, (n >> 8) & 255, n & 255)
}

/** WCAG relative luminance (0..1) of 0-255 sRGB channels. */
export function rgbLuminance(r: number, g: number, b: number): number {
  const lin = (c: number): number => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

const gradientLuminance = (g: CanvasGradient): number => (hexLuminance(g.from) + hexLuminance(g.to)) / 2

/** Image luminance after the dark dim overlay (and the optional gradient overlay). */
export function dimmedImageLuminance(bg: CanvasBackground, imageLuminance: number | null): number {
  const dimmed = (imageLuminance ?? UNKNOWN_IMAGE_LUMINANCE) * (1 - bg.imageDim / 100)
  if (!bg.imageGradientOverlay) return dimmed
  return dimmed * (1 - IMAGE_GRADIENT_OVERLAY_OPACITY) + gradientLuminance(bg.gradient) * IMAGE_GRADIENT_OVERLAY_OPACITY
}

/** Average luminance of what the canvas shows; null = default theme background. */
export function backgroundLuminance(bg: CanvasBackground, imageLuminance: number | null = null): number | null {
  if (bg.mode === 'color') return hexLuminance(bg.color)
  if (bg.mode === 'gradient') return gradientLuminance(bg.gradient)
  if (bg.mode === 'image' && bg.imageId) return dimmedImageLuminance(bg, imageLuminance)
  return null
}

/** Dot grid color that stays visible on the given luminance (null = theme default). */
export function dotColorFor(luminance: number | null): string {
  if (luminance === null) return DEFAULT_DOT
  return luminance > LIGHT_BACKGROUND_LUMINANCE ? DOT_ON_LIGHT : DOT_ON_DARK
}

/** True when a bright image is barely dimmed, so node edges and dots wash out. */
export function needsContrastWarning(bg: CanvasBackground, imageLuminance: number | null): boolean {
  if (bg.mode !== 'image' || !bg.imageId || imageLuminance === null) return false
  return dimmedImageLuminance(bg, imageLuminance) > BRIGHT_IMAGE_LUMINANCE
}

/** CSS `linear-gradient` for a gradient setting. */
export function gradientCss(g: CanvasGradient): string {
  return `linear-gradient(${g.angle}deg, ${g.from}, ${g.to})`
}

const FIT: Record<CanvasBackground['imageFit'], CSSProperties> = {
  cover: { backgroundSize: 'cover', backgroundRepeat: 'no-repeat', backgroundPosition: 'center' },
  contain: { backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center' },
  tile: { backgroundSize: 'auto', backgroundRepeat: 'repeat', backgroundPosition: 'top left' },
}

/** Styles of the wallpaper sub-layers; null = render nothing (default mode). */
export interface LayerStyles {
  base: CSSProperties
  dim?: CSSProperties
  overlay?: CSSProperties
}

/**
 * Layer styles for a background; `imageUrl` null in image mode means "no usable image".
 * A video gets no blur (it would re-run on every frame) and no CSS image: the `<video>` element
 * paints it. `hideImage` keeps the layer (dim, overlay) while a paused animation's still frame loads.
 */
export function layerStyles(bg: CanvasBackground, imageUrl: string | null, hideImage = false): LayerStyles | null {
  if (bg.mode === 'color') return { base: { background: bg.color } }
  if (bg.mode === 'gradient') return { base: { background: gradientCss(bg.gradient) } }
  if (bg.mode !== 'image' || !imageUrl) return null
  // Blur pulls transparent pixels in from outside the box; bleeding the layer past the edges by
  // twice the radius (clipped by the parent) keeps the borders solid.
  const bleed = bg.imageBlur * 2
  const picture: CSSProperties = isCanvasVideoId(bg.imageId) || hideImage ? {} : {
    backgroundImage: `url("${imageUrl}")`,
    ...FIT[bg.imageFit],
    ...(bg.imageBlur > 0 ? { filter: `blur(${bg.imageBlur}px)`, inset: -bleed } : {}),
  }
  return {
    base: { backgroundColor: 'var(--canvas-bg)', ...picture },
    dim: bg.imageDim > 0 ? { background: `rgba(0, 0, 0, ${bg.imageDim / 100})` } : undefined,
    overlay: bg.imageGradientOverlay ? { background: gradientCss(bg.gradient), opacity: IMAGE_GRADIENT_OVERLAY_OPACITY } : undefined,
  }
}
