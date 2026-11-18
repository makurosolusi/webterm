// Pure rules for moving wallpapers (video, animated WebP/GIF): what counts as moving, and when it plays.
import { isCanvasVideoId, type CanvasBackground, type CanvasPlayback } from '../shared/canvasBackground.schema'

/** True when the stored file moves. GIF counts even for settings saved before `imageAnimated` existed. */
export function isMovingMedia(bg: Pick<CanvasBackground, 'mode' | 'imageId' | 'imageAnimated'>): boolean {
  if (bg.mode !== 'image' || !bg.imageId) return false
  return bg.imageAnimated || isCanvasVideoId(bg.imageId) || bg.imageId.endsWith('.gif')
}

/** Playback after the OS "reduce motion" preference: only an explicit Always overrides it. */
export function effectivePlayback(playback: CanvasPlayback, reducedMotion: boolean): CanvasPlayback {
  return reducedMotion && playback !== 'always' ? 'off' : playback
}

/** Whether moving media should be running right now. */
export function shouldAnimate(playback: CanvasPlayback, windowActive: boolean): boolean {
  return playback === 'always' || (playback === 'focused' && windowActive)
}
