// Last color, stroke width and text size: a per-viewer convenience, so every access is guarded (private
// windows and blocked storage throw) and a bad value falls back to the defaults.
import { SHOT_COLORS, SHOT_TEXT_SIZES, SHOT_WIDTHS } from '../shot.palette'
import type { Prefs } from './shot.ui.machine'

const KEY = 'webterm.screenshot.prefs'

/** Stored choices, each kept only when it is still one of the presets. */
export function loadPrefs(): Partial<Prefs> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (typeof raw !== 'object' || raw === null) return {}
    const p = raw as Record<string, unknown>
    const out: Partial<Prefs> = {}
    if (SHOT_COLORS.some((c) => c.value === p.color)) out.color = p.color as string
    if (SHOT_WIDTHS.includes(p.width as number)) out.width = p.width as number
    if (SHOT_TEXT_SIZES.includes(p.textSize as number)) out.textSize = p.textSize as number
    return out
  } catch {
    return {}
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // Storage is unavailable; the choice then only lasts until the overlay closes.
  }
}
