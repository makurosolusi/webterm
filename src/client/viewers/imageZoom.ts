// Image viewer zoom math (pure). Levels follow VS Code's image preview picker.

export const ZOOM_LEVELS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 20] as const
export const ZOOM_MIN = ZOOM_LEVELS[0]
export const ZOOM_MAX = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
/** Wheel/pinch sensitivity: scale *= e^(-deltaY * this). */
const WHEEL_ZOOM_RATE = 0.01

export const clampZoom = (s: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s))

/** Next preset above (`dir` > 0) or below the current scale, clamped to the ends. */
export function stepZoom(scale: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_LEVELS.find((l) => l > scale * 1.001) ?? ZOOM_MAX
  return [...ZOOM_LEVELS].reverse().find((l) => l < scale * 0.999) ?? ZOOM_MIN
}

/** Scale after one Ctrl/⌘-wheel or trackpad-pinch event (pinch arrives as ctrl+wheel). */
export const wheelZoom = (scale: number, deltaY: number): number => clampZoom(scale * Math.exp(-deltaY * WHEEL_ZOOM_RATE))

/** "Fit" never upscales a small image (VS Code and Quick Look show it at 100%). */
export function fitScale(nat: { w: number; h: number }, box: { w: number; h: number }): number {
  if (!nat.w || !nat.h || !box.w || !box.h) return 1
  return Math.min(1, box.w / nat.w, box.h / nat.h)
}

export const zoomLabel = (scale: number): string => `${Math.round(scale * 100)}%`
