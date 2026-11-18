// Canvas sampling of a loaded wallpaper frame (image or video): average luminance and a still frame.
import { rgbLuminance } from './canvasBackground.style'

/** Side of the downscaled canvas the average color is sampled from. */
const SAMPLE_SIZE = 16
/** Widest still frame kept for a paused animated image (a wallpaper never needs more). */
const STILL_MAX_WIDTH = 1920
const STILL_JPEG_QUALITY = 0.85

type Source = HTMLImageElement | HTMLVideoElement

/** Average luminance of a loaded frame, sampled on a tiny canvas; null if no 2D context. */
export function sampleLuminance(src: Source): number | null {
  const canvas = document.createElement('canvas')
  canvas.width = SAMPLE_SIZE
  canvas.height = SAMPLE_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(src, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
  const px = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
  let r = 0, g = 0, b = 0
  const n = px.length / 4
  for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2] }
  return rgbLuminance(r / n, g / n, b / n)
}

/** One frame of a loaded image (the first one for an animation) as a data URL; null if no 2D context. */
export function captureStill(img: HTMLImageElement): string | null {
  const scale = Math.min(1, STILL_MAX_WIDTH / (img.naturalWidth || STILL_MAX_WIDTH))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round((img.naturalWidth || STILL_MAX_WIDTH) * scale))
  canvas.height = Math.max(1, Math.round((img.naturalHeight || canvas.width) * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', STILL_JPEG_QUALITY)
}
